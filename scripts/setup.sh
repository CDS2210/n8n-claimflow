#!/usr/bin/env bash
# ClaimFlow one-command setup. Safe to re-run.
#   ./scripts/setup.sh
# 1. creates .env from .env.example and generates every placeholder secret
# 2. creates a local certificate authority + TLS certificates (certs/, ca-private/)
# 3. starts the Docker stack and waits for it
# 4. creates n8n credentials (inside the container, so secrets never touch disk)
# 5. encrypts the seed personal information
# 6. imports and publishes the workflows in workflows/
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1          # Git Bash on Windows: don't rewrite /paths or /CN=... arguments

log()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    ok  %s\n' "$*"; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not installed"; }
need docker; need openssl
docker info >/dev/null 2>&1 || die "Docker is not running. Start Docker Desktop and try again."
DC="docker compose"
HTTPS_PORT_DEFAULT=8443

# ── 1. .env ─────────────────────────────────────────────────────────
log "Environment (.env)"
[ -f .env ] || { cp .env.example .env; ok "created .env from .env.example"; }

# Replace a value only if it is empty or still a placeholder. Never prints the value.
set_secret() {
  local name="$1" value="$2" current
  current="$(grep -E "^${name}=" .env | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//')"
  if [ -z "$current" ] || [[ "$current" == change-me* ]] || [[ "$current" == replace-with* ]]; then
    if grep -qE "^${name}=" .env; then
      local tmp; tmp="$(mktemp)"
      awk -v n="$name" -v v="$value" 'BEGIN{FS=OFS="="} $1==n{print n"="v; next} {print}' .env > "$tmp" && mv "$tmp" .env
    else
      printf '%s=%s\n' "$name" "$value" >> .env
    fi
    ok "generated $name"
  fi
}
set_secret POSTGRES_SUPERUSER_PASSWORD "$(openssl rand -hex 16)"
set_secret N8N_DB_PASSWORD             "$(openssl rand -hex 16)"
set_secret CLAIMFLOW_DB_PASSWORD       "$(openssl rand -hex 16)"
set_secret N8N_ENCRYPTION_KEY          "$(openssl rand -hex 32)"
set_secret CLAIMFLOW_PII_KEY           "$(openssl rand -base64 32)"
set_secret CLAIMFLOW_PII_HMAC_KEY      "$(openssl rand -base64 32)"
set_secret CLAIMFLOW_STATUS_LINK_KEY   "$(openssl rand -base64 32)"
ok ".env ready (secrets are not printed)"
HTTPS_PORT="$(grep -E '^HTTPS_PORT=' .env | cut -d= -f2 | sed 's/[[:space:]]*#.*$//')"; HTTPS_PORT="${HTTPS_PORT:-$HTTPS_PORT_DEFAULT}"

# ── 2. Certificates ─────────────────────────────────────────────────
log "TLS certificates (local CA)"
mkdir -p certs ca-private
if [ ! -f certs/ca.crt ] || [ ! -f ca-private/ca.key ]; then
  openssl req -x509 -new -nodes -newkey rsa:2048 -sha256 -days 825 \
    -keyout ca-private/ca.key -out certs/ca.crt -subj "/CN=ClaimFlow Local Dev CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  ok "created local CA (certs/ca.crt; private key in ca-private/, never mounted)"
fi
issue() {   # issue <name> <subjectAltName>
  local name="$1" san="$2"
  [ -f "certs/${name}.crt" ] && return 0
  openssl req -new -nodes -newkey rsa:2048 -keyout "certs/${name}.key" -out "certs/${name}.csr" -subj "/CN=${name}" 2>/dev/null
  printf 'subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$san" > "certs/${name}.ext"
  openssl x509 -req -in "certs/${name}.csr" -CA certs/ca.crt -CAkey ca-private/ca.key -CAcreateserial \
    -out "certs/${name}.crt" -days 825 -sha256 -extfile "certs/${name}.ext" 2>/dev/null
  rm -f "certs/${name}.csr" "certs/${name}.ext" certs/ca.srl
  chmod 600 "certs/${name}.key" 2>/dev/null || true
  ok "issued certs/${name}.crt ($san)"
}
issue localhost "DNS:localhost,IP:127.0.0.1"
issue postgres  "DNS:postgres,DNS:localhost,IP:127.0.0.1"
issue mailpit   "DNS:mailpit"
for n in localhost postgres mailpit; do openssl verify -CAfile certs/ca.crt "certs/$n.crt" >/dev/null || die "certificate $n does not verify"; done
ok "all certificates verify against the CA"

# ── 3. Stack ────────────────────────────────────────────────────────
log "Starting the Docker stack"
$DC up -d
wait_healthy() {
  local svc="$1" s=""
  for _ in $(seq 1 60); do
    s="$(docker inspect -f '{{.State.Health.Status}}' "claimflow-${svc}-1" 2>/dev/null || true)"
    [ "$s" = healthy ] && { ok "$svc healthy"; return 0; }
    sleep 3
  done
  die "$svc did not become healthy (last status: ${s:-unknown}). Check: docker compose logs $svc"
}
wait_healthy postgres
wait_healthy n8n

# Local LLM: only when .env selects it
env_val() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//'; }
if [ "$(env_val LLM_MODE)" = "ollama" ]; then
  log "Local LLM (Ollama)"
  $DC --profile ollama up -d ollama
  model="$(env_val OLLAMA_MODEL)"
  for _ in $(seq 1 30); do $DC exec -T ollama ollama list >/dev/null 2>&1 && break; sleep 2; done
  if $DC exec -T ollama ollama list | awk 'NR>1{print $1}' | grep -qx "$model"; then
    ok "model $model already present"
  else
    echo "    pulling $model (first time only, can take a few minutes)..."
    $DC exec -T ollama ollama pull "$model" >/dev/null || die "could not pull $model"
    ok "pulled $model"
  fi
  if $DC logs ollama 2>&1 | grep -q 'library=CUDA'; then ok "Ollama is using the NVIDIA GPU"; else ok "Ollama is running on CPU (no GPU detected)"; fi
fi

# n8n CLI output includes noisy notices; keep it readable.
n8n_cli() { $DC exec -T n8n n8n "$@" 2>&1 | grep -viE 'migration lock|license SDK|Postgres 16 is outside' || true; }

# ── 4. Credentials ──────────────────────────────────────────────────
log "n8n credentials"
$DC exec -T n8n sh -c 'umask 077; node /scripts/lib/make-credentials.js /tmp/creds.json && n8n import:credentials --input=/tmp/creds.json 2>&1 | grep -iE "imported|error" ; rm -f /tmp/creds.json'

# ── 5. Seed PII ─────────────────────────────────────────────────────
log "Encrypting seed personal information"
$DC exec -T n8n node /scripts/encrypt-seed-pii.js

# ── 6. Workflows ────────────────────────────────────────────────────
log "Importing and publishing workflows"
shopt -s nullglob
files=(workflows/*.json)
wf_id()   { sed -n 's/^  "id": "\([^"]*\)",$/\1/p' "$1" | head -1; }
wf_name() { sed -n 's/^  "name": "\([^"]*\)",$/\1/p' "$1" | head -1; }
# Import everything first, then publish: a workflow that calls a sub-workflow must not be
# published before that sub-workflow exists.
# Demo mode (CLAIMFLOW_DEMO_MODE=true): publish the Demo Portal (07) and keep successful
# executions of the claim workflows, so each node's input/output can be inspected in n8n.
# Off: 07 is imported but stays unpublished (form + trace page return 404).
DEMO_ID=cfDemoPortal0001
DEMO_KEEP_RUNS=" pY62sSjeshgn8nDx cfFraudReview001 cfNotifications1 "
demo=false; [ "$(env_val CLAIMFLOW_DEMO_MODE | tr '[:upper:]' '[:lower:]')" = "true" ] && demo=true
for f in "${files[@]}"; do
  id="$(wf_id "$f")"; [ -n "$id" ] || die "no top-level id in $f"
  n8n_cli unpublish:workflow --id="$id" >/dev/null           # republishing requires unpublish first
  if $demo && [[ "$DEMO_KEEP_RUNS" == *" $id "* ]]; then
    $DC exec -T n8n node -e 'const fs=require("fs");const w=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));w.settings.saveDataSuccessExecution="all";fs.writeFileSync(process.argv[2],JSON.stringify(w));' "/$f" /tmp/wf-demo.json
    n8n_cli import:workflow --input=/tmp/wf-demo.json | grep -qi "imported" || die "could not import $f"
    $DC exec -T n8n rm -f /tmp/wf-demo.json
    ok "imported: $(wf_name "$f") (demo mode: keeps successful executions)"
  else
    n8n_cli import:workflow --input="/$f" | grep -qi "imported" || die "could not import $f"
    ok "imported: $(wf_name "$f")"
  fi
done
# n8n won't publish a workflow until every sub-workflow it calls is published, so publish in
# passes: anything blocked by an unpublished sub-workflow waits for the next pass.
pending=()
for f in "${files[@]}"; do
  if [ "$(wf_id "$f")" = "$DEMO_ID" ] && ! $demo; then ok "not published: $(wf_name "$f") (CLAIMFLOW_DEMO_MODE is not true)"; continue; fi
  pending+=("$f")
done
while [ "${#pending[@]}" -gt 0 ]; do
  blocked=(); last_err=""
  for f in "${pending[@]}"; do
    id="$(wf_id "$f")"; name="$(wf_name "$f")"
    out="$(n8n_cli publish:workflow --id="$id")"
    if echo "$out" | grep -qi "which is not published"; then
      blocked+=("$f"); last_err="$out"
    elif echo "$out" | grep -qi "failed\|cannot publish"; then
      echo "$out" | sed 's/^/    /'; die "could not publish '$name' ($id)"
    else
      ok "published: $name"
    fi
  done
  if [ "${#blocked[@]}" -eq "${#pending[@]}" ]; then
    echo "$last_err" | sed 's/^/    /'; die "publishing made no progress (missing or circular sub-workflow references)"
  fi
  pending=("${blocked[@]}")
done

# ── 7. Smoke test ───────────────────────────────────────────────────
log "Smoke test (HTTPS through Caddy)"
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

cat <<EOF

ClaimFlow is running.
  n8n editor + webhooks : https://localhost:${HTTPS_PORT}
  Mailpit inbox         : https://localhost:$(grep -E '^MAILPIT_UI_PORT=' .env | cut -d= -f2 | sed 's/[[:space:]]*#.*$//')
  Postgres (TLS only)   : localhost:$(grep -E '^POSTGRES_PORT=' .env | cut -d= -f2 | sed 's/[[:space:]]*#.*$//')

$($demo && printf '  Demo claim form       : https://localhost:%s/form/claim-demo  (log in to n8n first)\n' "${HTTPS_PORT}")
First time? Create your n8n owner account at the editor URL.
Browser warnings? Trust certs/ca.crt once (see README, "Trusting the local CA").
EOF
