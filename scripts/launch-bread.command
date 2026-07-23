#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-4173}"
URL="http://localhost:${PORT}/"

NODE_BIN=""
NODE_CANDIDATES=(
  "${BREAD_NODE:-${READLIKE2000_NODE:-}}"
  "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
  "$(command -v node || true)"
  "/opt/homebrew/bin/node"
  "/usr/local/bin/node"
)

for candidate in "${NODE_CANDIDATES[@]}"; do
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    NODE_BIN="$candidate"
    break
  fi
done

if [[ -z "${NODE_BIN:-}" || ! -x "$NODE_BIN" ]]; then
  osascript -e 'display alert "bread" message "Node.js не найден. Установи Node.js или запусти читалку через Codex."'
  exit 1
fi

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  open "$URL"
  echo "bread уже запущен: $URL"
  exit 0
fi

LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOG_DIR"

cd "$PROJECT_DIR"
echo "Запускаю bread..."
echo "Адрес: $URL"
echo "Чтобы остановить сервер, закрой это окно Terminal или нажми Control-C."
echo ""

( sleep 1; open "$URL" ) &
PORT="$PORT" "$NODE_BIN" server.js 2>&1 | tee -a "$LOG_DIR/server.log"
