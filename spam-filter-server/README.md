# Sharkey moderation: spam classifier + CSAM filter

This directory contains the **external spam classifier** that the Sharkey backend calls,
plus operational docs for the **CSAM filter**. The two are independent:

| Feature | Where it runs | How |
| --- | --- | --- |
| Spam / ad / phishing | GPU host (this stack) | Qwen2.5-VL via vLLM, called over HTTPS |
| CSAM (known-hash) | Cloudflare edge + in-Sharkey | Cloudflare CSAM Tool + local MD5 denylist |

---

## 1. Spam classifier (GPU host: `dvd@point.dd.works`)

A single multimodal model (Qwen2.5-VL-7B-Instruct) reads post text **and** images
(including text inside images — no separate OCR) and returns `{label, confidence, reason}`.

### Deploy

```bash
cd spam-filter-server
cp .env.example .env
# edit .env: set CLASSIFIER_API_KEY (openssl rand -hex 32)
docker compose up -d --build
# first start downloads the model (several GB) into the hf-cache volume
curl -s localhost:19001/health    # {"ok": true}
```

GPU sizing: 7B fits a 24 GB GPU (RTX 4090 / A10 / L4) in bf16. On ≥40 GB you can switch
`--model` to `Qwen/Qwen2.5-VL-32B-Instruct-AWQ` for higher accuracy.

### Survive reboots (systemd)

`restart: unless-stopped` only helps if Docker starts at boot. Install the provided unit so
the stack comes up on every reboot (run on the GPU host, needs sudo):

```bash
sudo cp ~/spam-filter-server/spam-filter.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now docker          # ensure Docker starts at boot
sudo systemctl enable --now spam-filter     # bring up + enable the stack
# status / logs:
systemctl status spam-filter
```

The unit runs `docker compose up -d` (WorkingDirectory `/home/dvd/spam-filter-server`) on boot
and `docker compose down` on stop.

### Networking

- `vllm` is **not** published (internal compose network only).
- `classifier` listens on host port **19001** (plain HTTP).
- Your **nginx** terminates TLS at `spam.dd.works:443` and proxies to this host on 19001, e.g.:

  ```nginx
  server {
      listen 443 ssl;
      server_name spam.dd.works;
      # ssl_certificate / ssl_certificate_key ...
      location / {
          proxy_pass http://127.0.0.1:19001;   # or http://<gpu-host-ip>:19001
          proxy_set_header Host $host;
      }
  }
  ```

  If nginx runs on a different machine, open **TCP 19001** on the GPU host restricted to the
  nginx server's IP:

  ```bash
  ufw allow from <NGINX_IP> to any port 19001 proto tcp
  ```

  If nginx is on the same host, change the compose port mapping to `127.0.0.1:19001:8080` so
  19001 is never exposed externally. The bearer token (`CLASSIFIER_API_KEY`) is a second layer.

The bearer token (`CLASSIFIER_API_KEY`) is a second layer of defense.

### Point Sharkey at it

In Sharkey **admin settings** (or via `admin/update-meta`):

| setting | value |
| --- | --- |
| `enableSpamFilter` | `true` |
| `spamFilterServerUrl` | `https://spam.dd.works` |
| `spamFilterApiKey` | the same `CLASSIFIER_API_KEY` |
| `spamFilterModeratorUserId` | the user id of **@dvd** (sends DMs / is the suspending moderator) |
| `moderationReportEmail` | `zjdavid.2003@gmail.com` (daily digest recipient) |

Thresholds (`spamFilterThresholdSpam` etc.), `spamAccountMaxAgeDays` (default 365 — only
new accounts are scanned), `spamWindowDays`/`spamCountThreshold` (rolling-window auto-suspend,
default 5 in 30 days) are all tunable.

### What happens on a hit
Real-time, per new post (local + remote), for accounts younger than `spamAccountMaxAgeDays`:
note is hidden (visibility → author-only) and federated copies are retracted via AP Delete;
a `spam_log` row is recorded; **local** authors get a DM from @dvd; at the rolling-window
threshold the account is suspended. Fail-open: if this service is down, posting is unaffected.

---

## 2. CSAM filter (no GPU)

> **Legal:** once you have actual knowledge of CSAM you are (US, 18 U.S.C. §2258A) required to
> report to the **NCMEC CyberTipline** and preserve evidence (~90 days), and must not keep it
> accessible. This system detects/quarantines/preserves/alerts — **filing the report is your
> operational step.**

### 2a. Cloudflare CSAM Scanning Tool (primary known-CSAM net)
The instance is behind Cloudflare, so enable the built-in tool — it hash-matches images
served through Cloudflare against NCMEC's database and can auto-notify:

1. Cloudflare dashboard → your zone → **Caching → CSAM Scanning Tool**.
2. Complete the NCMEC reporting details and enable.

This is the real coverage for *novel/unknown* known-CSAM. No Sharkey code involved.

### 2b. In-Sharkey MD5 denylist (re-upload net)
At upload (async), Sharkey matches each image's MD5 against an admin-controlled denylist
(`csam_denylist`). On a match the file is **quarantined** (de-served with HTTP 451, not
deleted — evidence preserved), an urgent abuse report is raised, and it is **held for review**
(no auto-suspend). PhotoDNA was intentionally not integrated (requires a registered company).

> Limitation: the MD5 denylist only catches *re-uploads of already-flagged images*. Novel
> material relies on the Cloudflare layer above.

Enable with `enableCsamFilter = true`. Admin API:

- `admin/csam/add-denylist` `{ hashType: 'md5', hashValue, memo? }`
- `admin/csam/list-denylist`, `admin/csam/delete-denylist`
- `admin/csam/list-quarantine` `{ status? }`
- `admin/csam/resolve-quarantine` `{ id, action: 'confirm' | 'dismiss' }`
  - `confirm`: keep file de-served (evidence) + suspend uploader if `csamAutoSuspendOnConfirm`.
  - `dismiss`: restore the file (false positive).

You can compute an image's MD5 with `md5sum <file>` to add it to the denylist.

---

## 3. Daily digest emails
Two repeatable jobs (09:00 daily) email `moderationReportEmail` via the configured Mailgun:
- **spam** digest: counts (local/remote) + per-post note links and image links; large lists
  attach a `.txt`.
- **csam** digest: counts + internal review links only — **never** media links/attachments.

Empty days are skipped unless `moderationReportEmailSkipIfEmpty = false`.
