#!/bin/zsh
set -euo pipefail

SUPPORT_DIR="$HOME/Library/Application Support/bread/reader"
ENV_FILE="$SUPPORT_DIR/.env"

echo "bread — Gemini translation setup"
echo ""
echo "Create an API key at https://aistudio.google.com/api-keys"
echo "The key will be stored only in:"
echo "$ENV_FILE"
echo ""
printf "Paste your Gemini API key: "
read -r -s API_KEY
echo ""

if [[ -z "$API_KEY" ]]; then
  echo "No key entered. Nothing was changed."
  exit 1
fi

if [[ "$API_KEY" == *[!A-Za-z0-9_-]* ]]; then
  echo "The key contains unexpected characters. Nothing was changed."
  exit 1
fi

mkdir -p "$SUPPORT_DIR"
umask 077
printf 'GEMINI_API_KEY=%s\nGEMINI_MODEL=gemini-3.1-flash-live-preview\n' "$API_KEY" > "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo ""
echo "Gemini translation is configured."
echo "Quit bread completely and open it again to apply the key."
