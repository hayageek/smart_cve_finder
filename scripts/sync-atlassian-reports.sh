#!/bin/bash
# Sync new exploit artifacts in volumes/atlassian_reports to its git remote.
# Cron needs only one line — see scripts/crontab.atlassian-reports.example
set -euo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"

REPO_ROOT="/Users/rskusuma/Documents/Security/smart_cve_finder"
REPORTS_DIR="${REPORTS_DIR:-${REPO_ROOT}/volumes/atlassian_reports}"
LOG_DIR="${REPO_ROOT}/volumes/logs"
LOG_FILE="${LOG_DIR}/atlassian-reports-sync.log"

# Optional overrides for non-interactive cron (does not write to git config).
GIT_USER_NAME="${REPORTS_GIT_USER_NAME:-}"
GIT_USER_EMAIL="${REPORTS_GIT_USER_EMAIL:-}"

log() {
  mkdir -p "${LOG_DIR}"
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "${LOG_FILE}"
}

git_cmd() {
  if [[ -n "${GIT_USER_NAME}" && -n "${GIT_USER_EMAIL}" ]]; then
    git -c "user.name=${GIT_USER_NAME}" -c "user.email=${GIT_USER_EMAIL}" "$@"
  else
    git "$@"
  fi
}

main() {
  if [[ ! -d "${REPORTS_DIR}/.git" ]]; then
    log "ERROR: ${REPORTS_DIR} is not a git repository"
    exit 1
  fi

  cd "${REPORTS_DIR}"

  git_cmd add -A

  if git_cmd diff --cached --quiet; then
    log "No changes in ${REPORTS_DIR}"
    exit 0
  fi

  timestamp="$(date '+%Y-%m-%d %H:%M:%S %Z')"
  message="Auto-sync exploit reports ${timestamp}"

  git_cmd commit -m "${message}"

  branch="$(git branch --show-current)"
  if [[ -z "${branch}" ]]; then
    log "ERROR: detached HEAD; cannot push"
    exit 1
  fi

  git_cmd push origin "${branch}"
  log "Committed and pushed to origin/${branch}: ${message}"
}

main "$@"
