#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${BAIJIA_REPO_URL:-https://github.com/SYLONG7708/Baijia.git}"
BRANCH="${BAIJIA_BRANCH:-main}"
INSTALL_DIR="${BAIJIA_INSTALL_DIR:-/opt/baijia}"
SERVICE_USER="${BAIJIA_USER:-baijia}"
ENV_DIR="${BAIJIA_ENV_DIR:-/etc/baijia}"
ENV_FILE="${ENV_DIR}/baijia.env"
LOG_DIR="${BAIJIA_LOG_DIR:-/var/log/baijia}"
SERVICE_NAME="${BAIJIA_SERVICE_NAME:-baijia-pro}"
PORT="${PORT:-4173}"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This installer is for Ubuntu Linux." >&2
  exit 1
fi

if command -v sudo >/dev/null 2>&1; then
  SUDO=sudo
else
  SUDO=
fi

if [[ "$(id -u)" -ne 0 && -z "${SUDO}" ]]; then
  echo "Run as root or install sudo first." >&2
  exit 1
fi

run_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    ${SUDO} "$@"
  fi
}

run_user() {
  if [[ "$(id -u)" -eq 0 ]]; then
    sudo -H -u "${SERVICE_USER}" bash -lc "$*"
  else
    ${SUDO} -H -u "${SERVICE_USER}" bash -lc "$*"
  fi
}

node_major() {
  node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0
}

echo "==> Installing system packages"
run_root apt-get update
run_root apt-get install -y ca-certificates curl gnupg git build-essential unzip sudo

if [[ "$(node_major)" -lt 24 ]]; then
  echo "==> Installing Node.js 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | run_root bash -
  run_root apt-get install -y nodejs
fi

echo "==> Preparing service user and folders"
if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
  run_root useradd --system --create-home --shell /bin/bash "${SERVICE_USER}"
fi
run_root mkdir -p "${INSTALL_DIR}" "${ENV_DIR}" "${LOG_DIR}"
run_root chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}" "${LOG_DIR}"

echo "==> Fetching Baijia Pro"
if [[ -d "${INSTALL_DIR}/.git" ]]; then
  run_user "cd '${INSTALL_DIR}' && git fetch origin '${BRANCH}' && git checkout '${BRANCH}' && git pull --ff-only origin '${BRANCH}'"
else
  if [[ -n "$(find "${INSTALL_DIR}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    echo "${INSTALL_DIR} is not empty and is not a git repository." >&2
    exit 1
  fi
  run_user "git clone --branch '${BRANCH}' '${REPO_URL}' '${INSTALL_DIR}'"
fi

echo "==> Installing npm packages"
run_user "cd '${INSTALL_DIR}' && npm ci --omit=dev"

echo "==> Installing Playwright Chromium dependencies"
run_root bash -lc "cd '${INSTALL_DIR}' && npx playwright install-deps chromium"
run_user "cd '${INSTALL_DIR}' && npx playwright install chromium"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "==> Creating ${ENV_FILE}"
  API_TOKEN="$(openssl rand -hex 24 2>/dev/null || date +%s%N)"
  run_root tee "${ENV_FILE}" >/dev/null <<EOF
PORT=${PORT}
API_TOKEN=${API_TOKEN}
ALLBET_URL=
ALLBET_HEADLESS=true
SCRAPER_ENABLED=true
TRAINER_ENABLED=true
TELEGRAM_ENABLED=false
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_GROUP_NAME=結果群
TELEGRAM_POLL_INTERVAL_MS=2000
PUBLIC_API_BASE=
RAW_PAYLOAD_LOGGING=false
QUALITY_WATCHDOG_MS=120000
QUALITY_WATCHDOG_WARN_TABLES=6
QUALITY_WATCHDOG_COOLDOWN_MS=300000
EOF
  run_root chmod 600 "${ENV_FILE}"
else
  echo "==> Keeping existing ${ENV_FILE}"
fi

echo "==> Building web assets"
run_user "cd '${INSTALL_DIR}' && npm run build:web"

echo "==> Installing systemd service"
run_root install -m 0644 "${INSTALL_DIR}/deploy/baijia-pro.service" "/etc/systemd/system/${SERVICE_NAME}.service"
run_root systemctl daemon-reload
run_root systemctl enable --now "${SERVICE_NAME}"

if command -v ufw >/dev/null 2>&1 && run_root ufw status | grep -qi "Status: active"; then
  echo "==> Opening local firewall TCP ${PORT}"
  run_root ufw allow "${PORT}/tcp"
fi

echo
echo "Baijia Pro service installed."
echo "Next steps:"
echo "  1. Edit secrets: sudo nano ${ENV_FILE}"
echo "  2. Restart:      sudo systemctl restart ${SERVICE_NAME}"
echo "  3. Check:        sudo systemctl status ${SERVICE_NAME} --no-pager"
echo "  4. Logs:         sudo journalctl -u ${SERVICE_NAME} -f"
echo "  5. Local test:   curl http://127.0.0.1:${PORT}/api/monitor"
