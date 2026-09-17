#!/usr/bin/env bash
# NF-01 — repository-wide credential scan. Runs on the host, not in the backend
# container, because the container only mounts the backend tree and cannot see
# docker-compose.yml or README.md.
#
#   ./scripts/audit-secrets.sh
#
# Exits 1 on any finding that is not explicitly allowlisted below.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

# Unambiguously secrets, anywhere, in any tracked file.
# Format: <regex>|||<space-separated pathspecs to exclude>
FORBIDDEN=(
  'AKIA[0-9A-Z]{16}|||'                                 # AWS access key id
  '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|||'
  '[a-z][a-z0-9+.-]*://[^[:space:]/]*:[^[:space:]/@]+@[a-z]|||'  # user:pass@host
  '\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|||' # signed JWT
  # A literal secret assignment. *.example files are templates whose entire
  # purpose is to carry placeholder values, so they are excluded here; the
  # committed-.env check below still applies to everything.
  '^(JWT_SECRET|DATABASE_PASSWORD|S3_SECRET_ACCESS_KEY|DB_PASSWORD)=[^[:space:]]{8,}|||:!*.example'
)

# Values that are obviously placeholders. Without this the scan flags every
# tutorial line in the repository and gets switched off within a week.
PLACEHOLDER='^(password|passwd|secret|changeme|change[-_]me.*|your[-_].*|placeholder|example.*|secure_password_here|dev[-_]only|x+|<[^>]*>|\$\{[^}]*\})$'

findings=0

scan() {
  local entry="$1"
  local pat="${entry%%|||*}"
  local rest="${entry#*|||}"
  local pathspecs=()
  [[ -n "$rest" ]] && read -ra pathspecs <<< "$rest"

  # git grep already searches tracked files only, so no pathspec is needed
  # unless a pattern has exclusions.
  local cmd=(git grep -nIE "$pat")
  (( ${#pathspecs[@]} )) && cmd+=(-- "${pathspecs[@]}")

  local hit file line body value
  while IFS= read -r hit; do
    [[ -z "$hit" ]] && continue
    file="${hit%%:*}"
    line="${hit#*:}"
    body="${line#*:}"
    # For KEY=value findings, judge the value rather than the line. CR is
    # stripped because half this repository is CRLF, and a trailing \r makes an
    # exact-match allowlist silently stop matching (the same trap as ETL-05).
    value=$(printf '%s' "$body" | tr -d '\r' | sed -n 's/^[A-Z_][A-Z0-9_]*=//p')
    if [[ -n "$value" ]] && printf '%s' "$value" | grep -qiE "$PLACEHOLDER"; then
      continue
    fi
    echo "LEAK  $file:$line"
    echo "      > ${body:0:100}"
    findings=$((findings + 1))
  done < <("${cmd[@]}" 2>/dev/null)
}

for entry in "${FORBIDDEN[@]}"; do
  scan "$entry"
done

# A committed .env is a finding regardless of its contents.
while IFS= read -r hit; do
  [[ -z "$hit" ]] && continue
  echo "LEAK  $hit  (a .env file is tracked)"
  findings=$((findings + 1))
done < <(git ls-files | grep -E '(^|/)\.env$' || true)

if [[ $findings -gt 0 ]]; then
  echo
  echo "$findings finding(s). Rotate anything real before committing again."
  exit 1
fi

echo "No credential findings."
