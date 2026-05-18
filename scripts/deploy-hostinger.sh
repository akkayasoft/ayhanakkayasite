#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-$ROOT_DIR/.env.deploy}"
DRY_RUN="false"

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN="true"
fi

if [[ -f "$DEPLOY_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$DEPLOY_ENV_FILE"
fi

: "${HOSTINGER_SSH_HOST:?HOSTINGER_SSH_HOST is required (set it in .env.deploy)}"
: "${HOSTINGER_SSH_USER:?HOSTINGER_SSH_USER is required (set it in .env.deploy)}"
: "${HOSTINGER_APP_DIR:?HOSTINGER_APP_DIR is required (set it in .env.deploy)}"
: "${HOSTINGER_BRANCH:=main}"
: "${HOSTINGER_PORT:=22}"

if [[ -z "${HOSTINGER_RESTART_COMMAND:-}" ]]; then
  echo "HOSTINGER_RESTART_COMMAND is required in .env.deploy"
  echo "Example: HOSTINGER_RESTART_COMMAND='pm2 restart ayhanakkayasite || pm2 start src/app.js --name ayhanakkayasite'"
  exit 1
fi

REMOTE="${HOSTINGER_SSH_USER}@${HOSTINGER_SSH_HOST}"

read -r -d '' REMOTE_SCRIPT <<'EOF' || true
set -euo pipefail
HOSTINGER_APP_DIR="$1"
HOSTINGER_BRANCH="$2"
HOSTINGER_RESTART_COMMAND="$3"

cd "$HOSTINGER_APP_DIR"

echo "[remote] pwd: $(pwd)"
echo "[remote] fetch..."
git fetch --all --prune
echo "[remote] checkout branch..."
git checkout "$HOSTINGER_BRANCH"
echo "[remote] pull..."
git pull --ff-only origin "$HOSTINGER_BRANCH"
echo "[remote] install dependencies..."
npm ci --omit=dev || npm install --omit=dev
echo "[remote] restart..."
eval "$HOSTINGER_RESTART_COMMAND"
echo "[remote] deploy done."
EOF

echo "Deploy target: $REMOTE"
echo "App dir: $HOSTINGER_APP_DIR"
echo "Branch: $HOSTINGER_BRANCH"
echo "Port: $HOSTINGER_PORT"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "Dry run mode: no SSH command executed."
  exit 0
fi

ssh -p "$HOSTINGER_PORT" "$REMOTE" \
  "bash -s -- \"$HOSTINGER_APP_DIR\" \"$HOSTINGER_BRANCH\" \"$HOSTINGER_RESTART_COMMAND\"" <<< "$REMOTE_SCRIPT"
