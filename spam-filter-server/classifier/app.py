"""
Thin FastAPI wrapper around a vLLM-served Qwen model.

Exposes POST /classify which takes post text + image URLs and returns a spam verdict.
For speed the model emits a SINGLE token ("yes"/"no"); confidence is derived from the
token logprob, so the caller can still threshold. The model reads text inside images
natively, so no separate OCR is needed.

Auth: every request must carry `Authorization: Bearer <CLASSIFIER_API_KEY>`.
The vLLM upstream (VLLM_BASE_URL) is never exposed publicly — see docker-compose.yml.
"""
import os
import math

import httpx
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

VLLM_BASE_URL = os.environ.get("VLLM_BASE_URL", "http://vllm:8000/v1")
MODEL = os.environ.get("MODEL", "Qwen/Qwen3.5-4B")
API_KEY = os.environ.get("CLASSIFIER_API_KEY", "")
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
    "download links, get-rich-quick schemes.\n\n"
    "Answer \"no\" for everything else. In particular, the following are NOT spam:\n"
    "- An individual creator/artist sharing or selling their OWN work, commissions, shop, or "
    "assets (e.g. booth.pm, skima, Gumroad, BOOTH, a Steam wishlist), even occasionally repeated.\n"
    "- Adult/NSFW content, and adult creators promoting their OWN paid content (e.g. Fantia, "
    "Fanbox, Pixiv, Patreon, OnlyFans, Ci-en, fantia.jp links).\n"
    "- Game/community posts: login bonuses, gacha/referral/friend codes, game IDs (e.g. Genshin "
    "UID), event hashtags and giveaways run by the game.\n"
    "- Repeated words/characters/custom emoji (:emoji:), copypasta, keysmashes, venting, "
    "excitement, jokes, shitposts, personal updates, opinions, questions, replies and normal "
    "conversation, news/article sharing, political or social discussion.\n\n"
    "If you are unsure, answer \"no\". Output only the single word \"yes\" or \"no\", nothing else."
)

app = FastAPI(title="Sharkey spam classifier")


class ClassifyRequest(BaseModel):
    text: str = ""
    image_urls: list[str] = Field(default_factory=list)
    model: str | None = None


class ClassifyResponse(BaseModel):
    label: str          # "spam" or "ham" (kept in the spam/ad/phishing/ham vocabulary for the caller)
    confidence: float
    reason: str


def _check_auth(authorization: str | None) -> None:
    if not API_KEY:
        return  # auth disabled (not recommended)
    if authorization != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail="unauthorized")


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


@app.get("/health")
async def health() -> dict:
    return {"ok": True}


@app.post("/classify", response_model=ClassifyResponse)
async def classify(req: ClassifyRequest, authorization: str | None = Header(default=None)) -> ClassifyResponse:
    _check_auth(authorization)

    content: list[dict] = [{"type": "text", "text": req.text or "(no text)"}]
    for url in req.image_urls[:4]:
        content.append({"type": "image_url", "image_url": {"url": url}})

    payload = {
        "model": req.model or MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": content},
        ],
        "temperature": 0,
        "max_tokens": 1,
        "logprobs": True,
        "top_logprobs": 20,
        # Qwen3.5 is a reasoning model; disable thinking so it answers yes/no directly.
        "chat_template_kwargs": {"enable_thinking": False},
    }

    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            resp = await client.post(f"{VLLM_BASE_URL}/chat/completions", json=payload)
            resp.raise_for_status()
            data = resp.json()
            choice = data["choices"][0]
            token = (choice["message"]["content"] or "").strip().lower()
    except (httpx.HTTPError, KeyError, IndexError) as e:
        raise HTTPException(status_code=502, detail=f"inference error: {e}")

    is_spam = token.startswith("y")

    # Confidence from the first-token logprobs, when available.
    p_yes = None
    try:
        p_yes = _prob_yes((choice.get("logprobs") or {}).get("content") or [])
    except Exception:
        p_yes = None

    if p_yes is None:
        confidence = 0.9 if is_spam else 0.9
    else:
        confidence = p_yes if is_spam else (1.0 - p_yes)
    confidence = max(0.0, min(1.0, confidence))

    return ClassifyResponse(label="spam" if is_spam else "ham", confidence=confidence, reason="")
