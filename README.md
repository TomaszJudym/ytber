# ytber — YouTube time tracker

Two components:

- `extension/` — Brave/Chrome MV3 extension (vanilla JS). Counts seconds while
  any open window's active tab is YouTube; flushes deltas to the worker.
- `worker/` — Cloudflare Worker (Rust, `workers-rs`). Stores per-day totals in KV
  and sends a daily Telegram report via cron.

---

## 1. Telegram bot

1. In Telegram, message **@BotFather** → `/newbot` → follow prompts → copy the
   **token** (`123456:ABC-...`).
2. Send any message to your new bot (so it has a chat to reply to).
3. Fetch your **chat_id**:
   ```sh
   curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
   ```
   Read `result[].message.chat.id` from the JSON.

---

## 2. Cloudflare Worker

Prereqs: `wrangler` (`npm i -g wrangler`), Rust + wasm target
(`rustup target add wasm32-unknown-unknown`).

```sh
wrangler login              # only manual step
cd worker && ./setup.sh
```

`setup.sh` generates `INGEST_SECRET`, prompts (optionally) for the Telegram
token/chat id, deploys, and prints the **Worker URL** and **Ingest secret** to
paste into the extension options.

### Testing

```sh
# Local dev with the scheduled (cron) handler enabled.
wrangler dev --test-scheduled

# In another shell — exercise ingest:
curl -X POST http://localhost:8787/ingest \
  -H "X-Ingest-Secret: <INGEST_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"date":"2026-07-22","seconds":120,"report_now":true}'

# Trigger the cron path (daily report + stale-key cleanup):
curl "http://localhost:8787/__scheduled?cron=0+4+*+*+*"

# Live logs from the deployed worker:
wrangler tail
```

---

## 3. Extension (Brave / Chrome)

1. Open `brave://extensions` (or `chrome://extensions`).
2. Enable **Developer mode** (top-right).
3. **Load unpacked** → select the `extension/` directory.
4. Click the extension icon → open **Options** → enter the **Worker URL** and the
   **Ingest secret** (same value as `INGEST_SECRET`) → **Save**.

The extension is inert (no network calls) until both fields are set.

### Notes

- **Host permission:** `manifest.json` grants `https://*.workers.dev/*`. If you
  deploy the worker on a custom domain, replace that pattern with your host.
- **Popup** shows today's live total and a **Report now** button (sends an
  immediate partial report to Telegram).
- Time is counted while any open window's active tab is a `youtube.com` URL
  (independent of OS focus); deltas flush every ~90 s, on navigating away, and on
  tab close.
