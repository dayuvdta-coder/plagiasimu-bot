#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Jalankan script ini sebagai root: sudo bash scripts/install-ubuntu-vps.sh" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
SERVICE_NAME="${SERVICE_NAME:-turnitin-pool}"
NODE_MAJOR="${NODE_MAJOR:-20}"
APP_USER="${APP_USER:-${SUDO_USER:-turnitin}}"

if ! id "${APP_USER}" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "${APP_USER}"
fi

APP_GROUP="${APP_GROUP:-$(id -gn "${APP_USER}")}"
APP_HOME="$(getent passwd "${APP_USER}" | cut -d: -f6)"
if [[ -z "${APP_HOME}" ]]; then
  APP_HOME="/home/${APP_USER}"
fi

ENV_FILE="${ENV_FILE:-${APP_DIR}/.env}"
ACCOUNTS_FILE="${TURNITIN_ACCOUNTS_FILE:-${APP_DIR}/akun-turnitin.txt}"
CURRENT_VIEW_EXPORT_DIR="${TURNITIN_CURRENT_VIEW_EXPORT_DIR:-${APP_HOME}/turnitin-current-view}"
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-${APP_DIR}/ms-playwright}"
HOST_VALUE="${HOST:-0.0.0.0}"
PORT_VALUE="${PORT:-3101}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
SYSTEMD_TEMPLATE="${APP_DIR}/deploy/systemd/turnitin-pool.service.template"
SYSTEMD_SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

apt_install() {
  DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
}

configure_firewall_port() {
  if ! command -v ufw >/dev/null 2>&1; then
    return
  fi

  ufw allow "${PORT_VALUE}/tcp" >/dev/null 2>&1 || true
}

ensure_nodejs() {
  if command -v node >/dev/null 2>&1; then
    local installed_major
    installed_major="$(node -p 'process.versions.node.split(".")[0]')"
    if [[ "${installed_major}" -ge "${NODE_MAJOR}" ]]; then
      NODE_BIN="$(command -v node)"
      return
    fi
  fi

  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    >/etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt_install nodejs
  NODE_BIN="$(command -v node)"
}

quote_env_value() {
  local value="$1"
  printf '"%s"' "${value//\"/\\\"}"
}

get_env_value() {
  local key="$1"
  local line
  line="$(grep -E "^${key}=" "${ENV_FILE}" | tail -n 1 || true)"
  if [[ -z "${line}" ]]; then
    return
  fi

  printf '%s' "${line#*=}" | sed 's/^"//; s/"$//'
}

set_env_value() {
  local key="$1"
  local value="$2"
  local escaped_key
  escaped_key="$(printf '%s\n' "${key}" | sed 's/[][\\/.^$*]/\\&/g')"
  if grep -q "^${escaped_key}=" "${ENV_FILE}"; then
    sed -i "s|^${escaped_key}=.*$|${key}=${value}|" "${ENV_FILE}"
  else
    printf '%s=%s\n' "${key}" "${value}" >>"${ENV_FILE}"
  fi
}

printf '==> Update apt cache\n'
apt-get update

printf '==> Install base packages\n'
apt_install ca-certificates curl gnupg git poppler-utils

printf '==> Open public port %s/tcp when ufw is available\n' "${PORT_VALUE}"
configure_firewall_port

printf '==> Ensure Node.js >= %s\n' "${NODE_MAJOR}"
ensure_nodejs

printf '==> Prepare app directories\n'
install -d -m 0755 -o "${APP_USER}" -g "${APP_GROUP}" \
  "${APP_DIR}/storage/uploads" \
  "${APP_DIR}/storage/reports" \
  "${APP_DIR}/storage/runtime" \
  "${APP_DIR}/deploy/systemd" \
  "${CURRENT_VIEW_EXPORT_DIR}" \
  "${PLAYWRIGHT_BROWSERS_PATH}"
touch "${ACCOUNTS_FILE}"
chown "${APP_USER}:${APP_GROUP}" "${ACCOUNTS_FILE}"
chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}"

if [[ ! -f "${ENV_FILE}" ]]; then
  if [[ -f "${APP_DIR}/.env.example" ]]; then
    cp "${APP_DIR}/.env.example" "${ENV_FILE}"
  else
    touch "${ENV_FILE}"
  fi
fi
chown "${APP_USER}:${APP_GROUP}" "${ENV_FILE}"

printf '==> Write default runtime env\n'
PANEL_SESSION_SECRET_VALUE="${PANEL_SESSION_SECRET:-$(get_env_value PANEL_SESSION_SECRET)}"
if [[ -z "${PANEL_SESSION_SECRET_VALUE}" ]]; then
  PANEL_SESSION_SECRET_VALUE="$("${NODE_BIN}" -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
fi
set_env_value "HOST" "$(quote_env_value "${HOST_VALUE}")"
set_env_value "PORT" "$(quote_env_value "${PORT_VALUE}")"
set_env_value "PANEL_AUTH_ENABLED" "true"
set_env_value "PANEL_AUTH_USERNAME" "$(quote_env_value "${PANEL_AUTH_USERNAME:-Andri14}")"
set_env_value "PANEL_AUTH_PASSWORD" "$(quote_env_value "${PANEL_AUTH_PASSWORD:-Andri14}")"
set_env_value "PANEL_SESSION_SECRET" "$(quote_env_value "${PANEL_SESSION_SECRET_VALUE}")"
set_env_value "PANEL_SESSION_COOKIE_NAME" "$(quote_env_value "${PANEL_SESSION_COOKIE_NAME:-turnitin_admin_session}")"
set_env_value "PANEL_SESSION_SECURE_COOKIE" "false"
set_env_value "TURNITIN_HEADLESS" "true"
set_env_value "TURNITIN_ACCOUNTS_FILE" "$(quote_env_value "${ACCOUNTS_FILE}")"
set_env_value "TURNITIN_CURRENT_VIEW_EXPORT_DIR" "$(quote_env_value "${CURRENT_VIEW_EXPORT_DIR}")"
set_env_value "PLAYWRIGHT_BROWSERS_PATH" "$(quote_env_value "${PLAYWRIGHT_BROWSERS_PATH}")"
set_env_value "TURNITIN_CHROMIUM_SANDBOX" "true"
set_env_value "PANEL_AUTH_ENABLED" "true"
set_env_value "PANEL_AUTH_USERNAME" "$(quote_env_value "${PANEL_AUTH_USERNAME:-Andri14}")"
set_env_value "PANEL_AUTH_PASSWORD" "$(quote_env_value "${PANEL_AUTH_PASSWORD:-Andri14}")"
set_env_value "TELEGRAM_BOT_ENABLED" "true"

printf '==> Install npm dependencies\n'
runuser -u "${APP_USER}" -- bash -lc "cd \"${APP_DIR}\" && npm ci"

printf '==> Install Playwright system dependencies\n'
cd "${APP_DIR}"
"${NODE_BIN}" node_modules/playwright/cli.js install-deps chromium

printf '==> Install Chromium for Playwright\n'
runuser -u "${APP_USER}" -- bash -lc \
  "cd \"${APP_DIR}\" && PLAYWRIGHT_BROWSERS_PATH=\"${PLAYWRIGHT_BROWSERS_PATH}\" npx playwright install chromium"

printf '==> Render systemd service\n'
if [[ ! -f "${SYSTEMD_TEMPLATE}" ]]; then
  echo "Template service tidak ditemukan: ${SYSTEMD_TEMPLATE}" >&2
  exit 1
fi

sed \
  -e "s|__APP_USER__|${APP_USER}|g" \
  -e "s|__APP_GROUP__|${APP_GROUP}|g" \
  -e "s|__APP_DIR__|${APP_DIR}|g" \
  -e "s|__ENV_FILE__|${ENV_FILE}|g" \
  -e "s|__NODE_BIN__|${NODE_BIN}|g" \
  "${SYSTEMD_TEMPLATE}" >"${SYSTEMD_SERVICE_FILE}"

printf '==> Enable and restart service\n'
systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

printf '\nSelesai.\n'
printf 'Service: %s\n' "${SERVICE_NAME}"
printf 'Status : systemctl status %s --no-pager\n' "${SERVICE_NAME}"
printf 'Logs   : journalctl -u %s -f\n' "${SERVICE_NAME}"
printf 'Env    : %s\n' "${ENV_FILE}"
printf 'Akun   : %s\n' "${ACCOUNTS_FILE}"
printf 'Ping   : curl -s http://%s:%s/api/auth/session\n' "${HOST_VALUE}" "${PORT_VALUE}"
printf 'Public : http://IP_VPS:%s\n' "${PORT_VALUE}"
printf 'Login  : %s / %s\n' "${PANEL_AUTH_USERNAME:-Andri14}" "${PANEL_AUTH_PASSWORD:-Andri14}"
