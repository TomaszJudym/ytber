# Task: YouTube time tracker — Brave extension + Cloudflare Worker (Rust)

Build two components. No CI/CD, no GitHub setup. Deliver code + deploy/install instructions only.

## Component 1: Browser extension (Manifest V3, vanilla JS, no build tools)

Directory: `extension/`

### Behavior
- Track time (seconds) the user spends on YouTube: counted while ANY open
  window's active tab URL matches `*://*.youtube.com/*`, regardless of which
  window (or app) holds OS focus.
- Implement via timestamps, not `setInterval`: on state change to "counting", store start timestamp; on state change to "not counting", add elapsed to accumulator. MV3 service workers suspend — persist in-progress start timestamp and accumulator in `chrome.storage.local` so no time is lost across worker restarts.
- Accumulate per calendar day, local time, key format `YYYY-MM-DD`. Split intervals crossing midnight.
- Flush (send accumulated unsent seconds to backend) on:
  - YouTube tab closed (`tabs.onRemoved`) or navigated away
  - every 90 seconds while counting (chrome.alarms, min period workaround: use 1.5 min alarm or timestamp check on events)
- Flush = POST JSON to `https://<WORKER_URL>/ingest`:
  ```json
  { "date": "YYYY-MM-DD", "seconds": <int>, "report_now": false }
  ```
  Header: `X-Ingest-Secret: <secret>`.
  Send DELTAS (unsent seconds only). On HTTP success reset unsent counter; on failure retain and retry at next flush. Never lose or double-count.

### Popup
- `popup.html` + `popup.js`, minimal.
- Shows today's running total (read from storage, live).
- One button **"Report now"**: triggers immediate flush with `"report_now": true`.
- Options section (or separate options page): two text inputs — Worker URL and ingest secret — saved to `chrome.storage.local`. Extension inert (no POSTs) until both set.

### Permissions
`tabs`, `storage`, `alarms`; host permission only for the worker URL pattern. Request nothing else.

## Component 2: Cloudflare Worker (Rust, `workers-rs` crate, deployed with wrangler)

Directory: `worker/`

### Bindings / secrets
- KV namespace binding: `TRACKER_KV`
- Secrets (via `wrangler secret put`): `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`, `INGEST_SECRET`
- `wrangler.toml` with: KV binding placeholder, cron trigger `0 4 * * *` (06:00 Europe/Warsaw in summer; add comment noting UTC offset caveat), and:
  ```toml
  [observability]
  enabled = true
  ```

### Endpoint `POST /ingest`
1. Validate `X-Ingest-Secret` against `INGEST_SECRET`; 401 on mismatch.
2. Parse body `{date, seconds, report_now}`. Validate: date matches `YYYY-MM-DD`, seconds is int 0..=86400. 400 otherwise.
3. `total = KV.get(date).unwrap_or(0) + seconds`; `KV.put(date, total)`.
4. If `report_now == true`: send Telegram message `"YouTube {date} (partial): {H}h {M}m"` with current total. Do NOT delete the key.
5. Respond 200 with JSON `{ "total": <int> }`.

### Scheduled handler (cron)
1. Compute yesterday's date (UTC is acceptable; note assumption in comment).
2. If key exists: send Telegram `"YouTube {date}: {H}h {M}m"`. If key missing: send `"YouTube {date}: 0m"`.
3. Then `KV.list()` and DELETE every key with date < today (all stale keys, not just yesterday — no historical data retained).
4. Log outcomes via `console_log!`; on Telegram API failure log error and do NOT delete that day's key (retry next cron).

### Telegram
`POST https://api.telegram.org/bot{TOKEN}/sendMessage`, body `{chat_id, text}`. Treat non-200 as failure.

### Rust specifics
- Add `console_error_panic_hook`, call `set_once()` at entry, so panics produce readable logs.
- No unwraps on external input; return proper HTTP errors.

## Deliverables
1. Full source for both components.
2. `README.md` covering only:
   - Worker: `wrangler kv namespace create`, fill `wrangler.toml`, `wrangler secret put` x3, `wrangler deploy`.
   - Telegram bot creation: @BotFather → token; obtain chat_id via `getUpdates`.
   - Extension: load unpacked in `brave://extensions`, enter Worker URL + secret in popup options.
   - Testing: `wrangler dev --test-scheduled` + curl for the cron path; `wrangler tail` for logs.

## Constraints
- Free-tier compliant: KV writes must stay well under 1000/day (90 s flush cadence satisfies this).
- No external dependencies beyond `worker`, `serde`, `console_error_panic_hook` (worker) and zero deps (extension).
- Keep both components minimal; no frameworks, no bundlers.
