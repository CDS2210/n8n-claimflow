#!/usr/bin/env bash
# ClaimFlow one-command setup: a convenience wrapper around the Docker-only steps. Safe to re-run.
#   ./scripts/setup.sh
# is the same as:
#   docker compose run --rm init     (first run: .env with fresh secrets, local CA + certificates)
#   docker compose up -d             (stack + the one-shot deploy service)
# then it waits for deploy to finish and runs an HTTPS smoke test. Everything runs in containers;
# this script needs only bash, Docker and curl.
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1          # Git Bash on Windows: don't rewrite /paths

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()  { printf '    ok  %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || die "Docker is required but not installed"
docker info >/dev/null 2>&1 || die "Docker is not running. Start Docker Desktop and try again."
env_val() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//'; }

log "Init (secrets + certificates, in a container)"
docker compose run --rm init | sed -n '/^    ok/p'

if [ "$(env_val LLM_MODE)" = "ollama" ] && [ "$(env_val COMPOSE_PROFILES)" != "ollama" ]; then
  echo "    note: LLM_MODE=ollama but COMPOSE_PROFILES is not 'ollama'; starting with --profile ollama"
  profile=(--profile ollama)
else
  profile=()
fi

log "Starting the stack"
docker compose "${profile[@]}" up -d
log "Deploy (credentials, seed PII, workflows)"
docker compose wait deploy >/dev/null 2>&1 || true
code="$(docker compose ps -a deploy --format '{{.ExitCode}}' | tail -1)"
docker compose logs --no-log-prefix deploy | grep -E '^\s+ok|ERROR|pulling|note' || true
[ "$code" = "0" ] || die "deploy failed (exit ${code:-?}). Full log: docker compose logs deploy"

log "Smoke test (HTTPS through Caddy)"
HTTPS_PORT="$(env_val HTTPS_PORT)"; HTTPS_PORT="${HTTPS_PORT:-8443}"
# Windows curl uses Schannel, which fails when it can't check revocation; a local CA has
# no revocation list, so ask Schannel for best effort. Other TLS backends don't need it.
CURL_TLS=(--cacert certs/ca.crt)
curl -V | grep -qi schannel && CURL_TLS+=(--ssl-revoke-best-effort)
for _ in $(seq 1 20); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "${CURL_TLS[@]}" "https://localhost:${HTTPS_PORT}/healthz" || true)"
  [ "$code" = 200 ] && break; sleep 2
done
[ "$code" = 200 ] || die "https://localhost:${HTTPS_PORT}/healthz returned ${code}"
ok "https://localhost:${HTTPS_PORT} answers over TLS (certificate verified)"

demo=false; [ "$(env_val CLAIMFLOW_DEMO_MODE | tr '[:upper:]' '[:lower:]')" = "true" ] && demo=true
cat <<EOF

ClaimFlow is running.
  n8n editor + webhooks : https://localhost:${HTTPS_PORT}
  Mailpit inbox         : https://localhost:$(env_val MAILPIT_UI_PORT)
  Postgres (TLS only)   : localhost:$(env_val POSTGRES_PORT)
$($demo && printf '  Demo claim form       : https://localhost:%s/form/claim-demo  (log in to n8n first)\n' "${HTTPS_PORT}")
First time? Create your n8n owner account at the editor URL.
Browser warnings? Trust certs/ca.crt once (see README, "Trusting the local CA").
EOF
