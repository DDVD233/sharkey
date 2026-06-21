# SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
# SPDX-License-Identifier: AGPL-3.0-only
#
# Sharkey local "service server": one FastAPI process exposing the CPU-light helpers the
# Sharkey backend calls on localhost. The Sharkey backend boot spawns and supervises this
# (so it lives inside the same pm2 process — no Docker, no separate service to start).
#
# Endpoints:
#   GET  /health   -> {"ok": true}
#   POST /detect   -> language detection via lingua-py (CPU only)
#   POST /classify -> spam/ad/phishing classification; proxies to a vLLM (OpenAI-compatible).
#                     The vLLM endpoint + key + model are passed in the request by Sharkey
#                     (single source of truth = the admin control panel), with env fallbacks.
#
# Env (all optional; request fields win):
#   SERVICE_HOST / SERVICE_PORT          bind address (default 127.0.0.1 / 3061)
#   VLLM_BASE_URL / VLLM_API_KEY / MODEL fallbacks for /classify
#   LANGDETECT_LOW_ACCURACY=1            lingua trigram-only mode (less RAM)

import os
import math

import httpx
from fastapi import FastAPI
from pydantic import BaseModel, Field
from lingua import LanguageDetectorBuilder

# ---------------------------------------------------------------------------
# Language detection (lingua)
# ---------------------------------------------------------------------------

_builder = LanguageDetectorBuilder.from_all_languages()
if os.environ.get("LANGDETECT_LOW_ACCURACY", "0") == "1":
    _builder = _builder.with_low_accuracy_mode()
_detector = _builder.with_preloaded_language_models().build()

# ---------------------------------------------------------------------------
# Spam classification (vLLM)
# ---------------------------------------------------------------------------

VLLM_BASE_URL = os.environ.get("VLLM_BASE_URL", "")
VLLM_API_KEY = os.environ.get("VLLM_API_KEY", "")
MODEL = os.environ.get("MODEL", "")
REQUEST_TIMEOUT = float(os.environ.get("REQUEST_TIMEOUT", "20"))

# Precise definition. Bias toward "no" to keep the flag rate low (<1% target).
# Distinction: impersonal commercial businesses & scams = spam; an individual user/creator
# promoting their OWN content (including adult content) = NOT spam.
SYSTEM_PROMPT = (
    "You are a spam filter for a Mastodon-style social network (Sharkey). "
    "Decide whether a post is unwanted. Answer with a SINGLE word: \"yes\" or \"no\".\n\n"
    "Answer \"yes\" ONLY if the post is clearly one of:\n"
    "- COMMERCIAL SPAM/ADVERTISING by a business or storefront: generic product/service "
    "promotion, dropshipping, SEO/keyword stuffing, affiliate farms, real-estate/hotel/clinic/"
    "supplement/logo ads, casino & gambling promos, mass-produced press-release or market-report "
    "posts, unsolicited bulk/identical link dumps.\n"
    "- PHISHING/SCAM: fake giveaways, crypto/airdrop/wallet scams, 'connect your wallet', "
    "'send your card number', credential or payment theft, impersonation, malware or pirated-app "
    "download links, get-rich-quick schemes.\n"
    "- ANONYMOUS SOLICITATION / CONTACT-TRADING: the real payload is OFF the post — it tells the "
    "reader to go elsewhere to get the goods or a contact. Examples: 'check/look at my profile "
    "name' (看我名字 / 看我的网名 / 注意看我名 / 看姐姐名字看篇), 'add my WeChat/QQ/Telegram' (加微信 / "
    "加VX / 扣扣 / 企鹅 / QQ群 + an id), escort/sex-work/包养 ads, paid-group or 代理 (reseller) "
    "recruiting, 'see name for 资源/片'. This is spam EVEN WHEN the content is adult, because it "
    "drives to an external handle instead of sharing the poster's own content in the post itself.\n\n"
    "EVASION IS ITSELF A SPAM SIGNAL. Treat deliberate obfuscation as strong evidence of spam: "
    "unicode filler/junk (e.g. runic 'ᚰ', decorative '☀' '❤' wedged between characters), full-width "
    "or math-style letters spelling normal words ('ＶＸ', '𝐗𝐂', '𝙠'), homophone/character "
    "substitution to dodge filters (威/薇 for 微信, 企鹅 for QQ, '+C' or '加C'), or a phone/ID number "
    "split by spaces or symbols (e.g. '4➕5➕1➕0', '75275+3636'). A short post that hides a contact "
    "handle, or sends the reader elsewhere to obtain goods/contact, is spam even if the literal "
    "words look innocent.\n\n"
    "Answer \"no\" for everything else. In particular, the following are NOT spam:\n"
    "- An individual creator/artist sharing or selling their OWN work, commissions, shop, or "
    "assets via a named link IN the post (e.g. booth.pm, skima, Gumroad, BOOTH, a Steam wishlist), "
    "even occasionally repeated. (Contrast: 'add my WeChat / look at my profile name for the "
    "content', with no actual content in the post, IS spam — see above.)\n"
    "- Adult/NSFW content, and adult creators promoting their OWN paid content via a named link "
    "(e.g. Fantia, Fanbox, Pixiv, Patreon, OnlyFans, Ci-en, fantia.jp links). Adult talk, art, or "
    "venting that is not selling or pointing off-post to a hidden contact is fine.\n"
    "- Game/community posts: login bonuses, gacha/referral/friend codes, game IDs (e.g. Genshin "
    "UID), event hashtags and giveaways run by the game.\n"
    "- Repeated words/characters/custom emoji (:emoji:), copypasta, keysmashes, venting, "
    "excitement, jokes, shitposts, personal updates, opinions, questions, replies and normal "
    "conversation, news/article sharing, political or social discussion.\n\n"
    "If you are unsure, answer \"no\". Output only the single word \"yes\" or \"no\", nothing else."
)

# A few labeled examples (bilingual, to anchor the legit-creator carve-out as well as the
# Chinese contact-solicitation / obfuscation patterns). Kept short since the model emits one token.
FEWSHOT: list[tuple[str, str]] = [
    ("新作公開しました！Fanboxで全部見れます → https://example.fanbox.cc/", "no"),
    ("今日の配信おつかれさま！すごく楽しかった", "no"),
    ("卧槽卧槽卧槽 哈哈哈哈哈", "no"),
    ("just shipped a new commission, prints are up on my gumroad if anyone wants one", "no"),
    ("注意看我名，是威哦", "yes"),
    ("看姐姐名字看篇", "yes"),
    ("CC-名字-看-电视ᚰ", "yes"),
    ("75275+3636+我的名字", "yes"),
    ("全国五星酒店vip卡 加微信办理", "yes"),
    ("进群领福利 群聊号码761777381", "yes"),
]

app = FastAPI(title="Sharkey service server")


class DetectRequest(BaseModel):
    text: str


class DetectResponse(BaseModel):
    lang: str | None  # ISO 639-1 (e.g. "en"), or None
    confidence: float | None = None


class ClassifyRequest(BaseModel):
    text: str = ""
    image_urls: list[str] = Field(default_factory=list)
    # vLLM connection — passed by Sharkey (single source of truth), env as fallback.
    vllm_url: str | None = None
    vllm_key: str | None = None
    model: str | None = None


class ClassifyResponse(BaseModel):
    label: str  # "spam" or "ham"
    confidence: float
    reason: str


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/detect", response_model=DetectResponse)
def detect(req: DetectRequest) -> DetectResponse:
    text = (req.text or "").strip()
    if not text:
        return DetectResponse(lang=None)
    language = _detector.detect_language_of(text)
    if language is None:
        return DetectResponse(lang=None)
    lang = language.iso_code_639_1.name.lower()
    confidence = _detector.compute_language_confidence(text, language)
    return DetectResponse(lang=lang, confidence=confidence)


def _prob_yes(logprobs_content: list) -> float | None:
    """Sum the probability mass of 'yes'-like tokens in the first position's top_logprobs."""
    if not logprobs_content:
        return None
    top = logprobs_content[0].get("top_logprobs") or []
    p_yes = 0.0
    seen = False
    for tl in top:
        tok = (tl.get("token") or "").strip().lower()
        if not tok:
            continue
        if tok.startswith("y"):
            p_yes += math.exp(tl["logprob"])
            seen = True
        elif tok.startswith("n"):
            seen = True
    return p_yes if seen else None


@app.post("/classify", response_model=ClassifyResponse)
async def classify(req: ClassifyRequest) -> ClassifyResponse:
    from fastapi import HTTPException

    base_url = (req.vllm_url or VLLM_BASE_URL or "").rstrip("/")
    api_key = req.vllm_key or VLLM_API_KEY
    model = req.model or MODEL
    if not base_url or not model:
        raise HTTPException(status_code=400, detail="vllm_url and model are required")
    if not base_url.endswith("/v1"):
        base_url = base_url + "/v1"

    content: list[dict] = [{"type": "text", "text": req.text or "(no text)"}]
    for url in req.image_urls[:4]:
        content.append({"type": "image_url", "image_url": {"url": url}})

    messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
    for ex_text, ex_answer in FEWSHOT:
        messages.append({"role": "user", "content": [{"type": "text", "text": ex_text}]})
        messages.append({"role": "assistant", "content": ex_answer})
    messages.append({"role": "user", "content": content})

    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0,
        "max_tokens": 1,
        "logprobs": True,
        "top_logprobs": 20,
        # Qwen3.5 is a reasoning model; disable thinking so it answers yes/no directly.
        "chat_template_kwargs": {"enable_thinking": False},
    }
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else None

    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            resp = await client.post(f"{base_url}/chat/completions", json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            choice = data["choices"][0]
            token = (choice["message"]["content"] or "").strip().lower()
    except (httpx.HTTPError, KeyError, IndexError) as e:
        raise HTTPException(status_code=502, detail=f"inference error: {e}")

    is_spam = token.startswith("y")

    p_yes = None
    try:
        p_yes = _prob_yes((choice.get("logprobs") or {}).get("content") or [])
    except Exception:
        p_yes = None

    if p_yes is None:
        confidence = 0.9
    else:
        confidence = p_yes if is_spam else (1.0 - p_yes)
    confidence = max(0.0, min(1.0, confidence))

    return ClassifyResponse(label="spam" if is_spam else "ham", confidence=confidence, reason="")


def _install_parent_death_signal():
    """On Linux, ask the kernel to send us SIGTERM if our parent (the Sharkey backend
    that spawned us) dies for *any* reason — including a SIGKILL the parent can't trap.
    Without this, a hard-killed/crashed backend leaves us orphaned (reparented to PID 1)
    still holding the service port, so the next backend boot fails to bind it (Errno 98)."""
    try:
        import ctypes
        import signal

        PR_SET_PDEATHSIG = 1  # from <linux/prctl.h>
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        libc.prctl(PR_SET_PDEATHSIG, signal.SIGTERM)

        # Guard the race where the parent already died before prctl() ran: in that case
        # the death signal would never arrive, so check for reparenting and exit.
        if os.getppid() == 1:
            os._exit(0)
    except Exception:
        # Best-effort: non-Linux or no libc/prctl — fall back to the Node-side supervisor.
        pass


if __name__ == "__main__":
    import uvicorn

    _install_parent_death_signal()

    uvicorn.run(
        app,
        host=os.environ.get("SERVICE_HOST", "127.0.0.1"),
        port=int(os.environ.get("SERVICE_PORT", "3061")),
        log_level="warning",
    )
