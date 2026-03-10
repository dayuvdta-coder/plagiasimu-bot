#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Jalankan sebagai root. Contoh: sudo REPO_URL=https://github.com/user/repo.git bash scripts/bootstrap-ubuntu-vps.sh" >&2
  exit 1
fi

REPO_URL="${REPO_URL:-${1:-}}"
REPO_BRANCH="${REPO_BRANCH:-${BRANCH:-main}}"
APP_DIR="${APP_DIR:-/opt/turnitin-pool}"
SERVICE_NAME="${SERVICE_NAME:-turnitin-pool}"
APP_USER="${APP_USER:-turnitin}"

log() {
  printf '==> %s\n' "$1"
}

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

ensure_repo_url() {
  if [[ -z "${REPO_URL}" ]]; then
    fail "REPO_URL wajib diisi. Contoh: sudo REPO_URL=https://github.com/user/repo.git bash scripts/bootstrap-ubuntu-vps.sh"
  fi
}

ensure_git() {
  if command -v git >/dev/null 2>&1; then
    return
  fi

  log "Install git"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y git
}

clone_or_update_repo() {
  local parent_dir
  parent_dir="$(dirname "${APP_DIR}")"
  install -d -m 0755 "${parent_dir}"

  if [[ -d "${APP_DIR}/.git" ]]; then
    local current_origin
    current_origin="$(git -C "${APP_DIR}" remote get-url origin 2>/dev/null || true)"
    if [[ -n "${current_origin}" && "${current_origin}" != "${REPO_URL}" ]]; then
      fail "APP_DIR sudah berisi repo lain. APP_DIR=${APP_DIR} origin=${current_origin}"
    fi

    log "Update repo di ${APP_DIR}"
    git -C "${APP_DIR}" fetch --depth 1 origin "${REPO_BRANCH}"
    if git -C "${APP_DIR}" show-ref --verify --quiet "refs/heads/${REPO_BRANCH}"; then
      git -C "${APP_DIR}" checkout "${REPO_BRANCH}"
    else
      git -C "${APP_DIR}" checkout -B "${REPO_BRANCH}" "origin/${REPO_BRANCH}"
    fi
    git -C "${APP_DIR}" pull --ff-only origin "${REPO_BRANCH}"
    return
  fi

  if [[ -e "${APP_DIR}" ]] && [[ -n "$(find "${APP_DIR}" -mindepth 1 -maxdepth 1 2>/dev/null)" ]]; then
    fail "APP_DIR=${APP_DIR} sudah ada dan tidak kosong, tetapi bukan repo git."
  fi

  log "Clone repo ${REPO_URL} (${REPO_BRANCH}) ke ${APP_DIR}"
  rm -rf "${APP_DIR}"
  git clone --depth 1 --branch "${REPO_BRANCH}" "${REPO_URL}" "${APP_DIR}"
}

run_project_installer() {
  local installer_path="${APP_DIR}/scripts/install-ubuntu-vps.sh"
  if [[ ! -f "${installer_path}" ]]; then
    fail "Installer utama tidak ditemukan: ${installer_path}"
  fi

  log "Jalankan installer project"
  APP_DIR="${APP_DIR}" \
  SERVICE_NAME="${SERVICE_NAME}" \
  APP_USER="${APP_USER}" \
  bash "${installer_path}"
}

print_summary() {
  printf '\nBootstrap selesai.\n'
  printf 'Repo    : %s\n' "${REPO_URL}"
  printf 'Branch  : %s\n' "${REPO_BRANCH}"
  printf 'App Dir : %s\n' "${APP_DIR}"
  printf 'Service : %s\n' "${SERVICE_NAME}"
  printf 'Status  : systemctl status %s --no-pager\n' "${SERVICE_NAME}"
  printf 'Logs    : journalctl -u %s -f\n' "${SERVICE_NAME}"
}

ensure_repo_url
ensure_git
clone_or_update_repo
run_project_installer
print_summary
