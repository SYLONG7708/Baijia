#!/usr/bin/env bash
set -euo pipefail

ARCHIVE="${1:-}"
INSTALL_DIR="${BAIJIA_INSTALL_DIR:-/opt/baijia}"
SERVICE_NAME="${BAIJIA_SERVICE_NAME:-baijia-pro}"
SERVICE_USER="${BAIJIA_USER:-baijia}"
DATA_DIR="${INSTALL_DIR}/data"

if [[ -z "${ARCHIVE}" ]]; then
  echo "Usage: sudo bash scripts/restore-cloud-data.sh /path/to/baijia-data.zip" >&2
  exit 1
fi

if [[ ! -f "${ARCHIVE}" ]]; then
  echo "Archive not found: ${ARCHIVE}" >&2
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
ROLLBACK_DIR="${DATA_DIR}.before-restore-$(date +%Y%m%d-%H%M%S)"
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

echo "==> Stopping ${SERVICE_NAME}"
systemctl stop "${SERVICE_NAME}" || true

echo "==> Extracting backup"
unzip -q "${ARCHIVE}" -d "${TMP_DIR}"
BACKUP_ROOT="$(find "${TMP_DIR}" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [[ -z "${BACKUP_ROOT}" ]]; then
  BACKUP_ROOT="${TMP_DIR}"
fi

if [[ ! -f "${BACKUP_ROOT}/baijia.sqlite" ]]; then
  echo "Backup does not contain baijia.sqlite" >&2
  exit 1
fi

echo "==> Backing up current data to ${ROLLBACK_DIR}"
mkdir -p "${DATA_DIR}"
cp -a "${DATA_DIR}" "${ROLLBACK_DIR}"

echo "==> Restoring SQLite data"
install -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0640 "${BACKUP_ROOT}/baijia.sqlite" "${DATA_DIR}/baijia.sqlite"
if [[ -f "${BACKUP_ROOT}/training.sqlite" ]]; then
  install -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0640 "${BACKUP_ROOT}/training.sqlite" "${DATA_DIR}/training.sqlite"
fi
if [[ -f "${BACKUP_ROOT}/monitor-reports.jsonl" ]]; then
  install -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0640 "${BACKUP_ROOT}/monitor-reports.jsonl" "${DATA_DIR}/monitor-reports.jsonl"
fi

rm -f "${DATA_DIR}/baijia.sqlite-wal" "${DATA_DIR}/baijia.sqlite-shm"
rm -f "${DATA_DIR}/training.sqlite-wal" "${DATA_DIR}/training.sqlite-shm"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${DATA_DIR}"

echo "==> Starting ${SERVICE_NAME}"
systemctl start "${SERVICE_NAME}"
systemctl status "${SERVICE_NAME}" --no-pager || true

echo
echo "Restore complete."
echo "Rollback copy: ${ROLLBACK_DIR}"
echo "Check: curl http://127.0.0.1:4173/api/monitor"
