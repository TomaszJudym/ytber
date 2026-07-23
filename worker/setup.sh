#!/usr/bin/env bash
# One-shot worker setup. Prereq: `wrangler login` (only manual step).
# Generates INGEST_SECRET, sets it, deploys, prints values for the extension.
set -euo pipefail
cd "$(dirname "$0")"

command -v wrangler >/dev/null || { echo "wrangler not found: npm i -g wrangler"; exit 1; }
wrangler whoami >/dev/null 2>&1 || { echo "Not logged in. Run: wrangler login"; exit 1; }

# Generate secret (openssl if present, else /dev/urandom).
if command -v openssl >/dev/null; then
  SECRET="$(openssl rand -hex 32)"
else
  SECRET="$(head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi

# Set ingest secret.
printf '%s' "$SECRET" | wrangler secret put INGEST_SECRET

# Optional Telegram secrets (blank = skip; set later with `wrangler secret put`).
read -rp "TELEGRAM_TOKEN (blank to skip): " TG_TOKEN
[ -n "$TG_TOKEN" ] && printf '%s' "$TG_TOKEN" | wrangler secret put TELEGRAM_TOKEN
read -rp "TELEGRAM_CHAT_ID (blank to skip): " TG_CHAT
[ -n "$TG_CHAT" ] && printf '%s' "$TG_CHAT" | wrangler secret put TELEGRAM_CHAT_ID

# Deploy, capture the worker URL.
OUT="$(wrangler deploy 2>&1)"
echo "$OUT"
URL="$(printf '%s\n' "$OUT" | grep -oE 'https://[^ ]+\.workers\.dev' | head -n1)"

echo
echo "=================== paste into extension options ==================="
echo "Worker URL:    ${URL:-<see deploy output above>}"
echo "Ingest secret: $SECRET"
echo "===================================================================="
