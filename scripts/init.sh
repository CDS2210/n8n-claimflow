#!/bin/sh
# ClaimFlow first-run setup. Runs INSIDE the one-shot `init` container (pinned Alpine + openssl),
# so the host needs nothing but Docker:
#   docker compose run --rm init
# Safe to re-run: it only fills in what's missing.
#   1. .env: created from .env.example; settings added to .env.example later are appended;
#      every placeholder secret is replaced with a fresh random value (never printed)
#   2. a local certificate authority (ca-private/, never mounted into any service) and TLS
#      certificates for localhost (Caddy), postgres and mailpit (certs/)
set -eu
cd /work

log() { printf '\n==> %s\n' "$*"; }
ok()  { printf '    ok  %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ -f .env.example ] || die "run this from the repo (docker compose run --rm init)"
command -v openssl >/dev/null 2>&1 || apk add --no-cache -q openssl >/dev/null || die "could not install openssl"

# ── 1. .env ─────────────────────────────────────────────────────────
log "Environment (.env)"
if [ ! -f .env ]; then cp .env.example .env; ok "created .env from .env.example"; fi
# Append settings that exist in .env.example but not in .env (e.g. after a git pull).
grep -E '^[A-Z0-9_]+=' .env.example | while IFS= read -r line; do
  name="${line%%=*}"
  if ! grep -qE "^${name}=" .env; then printf '%s\n' "$line" >> .env; ok "added new setting $name"; fi
done

# Replace a value only if it is empty or still a placeholder. Never prints the value.
set_secret() {
  name="$1"; value="$2"
  current="$(grep -E "^${name}=" .env | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//')"
  case "$current" in
    ''|change-me*|replace-with*)
      tmp="$(mktemp)"
      awk -v n="$name" -v v="$value" 'BEGIN{FS=OFS="="} $1==n{print n"="v; next} {print}' .env > "$tmp"
      cat "$tmp" > .env; rm -f "$tmp"          # keep the file (and its owner), just rewrite it
      ok "generated $name" ;;
  esac
}
set_secret POSTGRES_SUPERUSER_PASSWORD "$(openssl rand -hex 16)"
set_secret N8N_DB_PASSWORD             "$(openssl rand -hex 16)"
set_secret CLAIMFLOW_DB_PASSWORD       "$(openssl rand -hex 16)"
set_secret N8N_ENCRYPTION_KEY          "$(openssl rand -hex 32)"
set_secret CLAIMFLOW_PII_KEY           "$(openssl rand -base64 32)"
set_secret CLAIMFLOW_PII_HMAC_KEY      "$(openssl rand -base64 32)"
set_secret CLAIMFLOW_STATUS_LINK_KEY   "$(openssl rand -base64 32)"
ok ".env ready (secrets are not printed)"

# ── 2. Certificates ─────────────────────────────────────────────────
log "TLS certificates (local CA)"
mkdir -p certs ca-private
if [ ! -f certs/ca.crt ] || [ ! -f ca-private/ca.key ]; then
  openssl req -x509 -new -nodes -newkey rsa:2048 -sha256 -days 825 \
    -keyout ca-private/ca.key -out certs/ca.crt -subj "/CN=ClaimFlow Local Dev CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  # A new CA invalidates certificates issued by an old one.
  for n in localhost postgres mailpit; do rm -f "certs/$n.crt" "certs/$n.key"; done
  ok "created local CA (certs/ca.crt; private key in ca-private/, never mounted)"
fi
issue() {   # issue <name> <subjectAltName>
  name="$1"; san="$2"
  [ -f "certs/${name}.crt" ] && [ -f "certs/${name}.key" ] && return 0
  openssl req -new -nodes -newkey rsa:2048 -keyout "certs/${name}.key" -out "certs/${name}.csr" -subj "/CN=${name}" 2>/dev/null
  printf 'subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$san" > "certs/${name}.ext"
  openssl x509 -req -in "certs/${name}.csr" -CA certs/ca.crt -CAkey ca-private/ca.key -CAcreateserial \
    -out "certs/${name}.crt" -days 825 -sha256 -extfile "certs/${name}.ext" 2>/dev/null
  rm -f "certs/${name}.csr" "certs/${name}.ext" certs/ca.srl
  ok "issued certs/${name}.crt ($san)"
}
issue localhost "DNS:localhost,IP:127.0.0.1"
issue postgres  "DNS:postgres,DNS:localhost,IP:127.0.0.1"
issue mailpit   "DNS:mailpit"
for n in localhost postgres mailpit; do openssl verify -CAfile certs/ca.crt "certs/$n.crt" >/dev/null || die "certificate $n does not verify"; done
# Service keys: owner-only (the services read them as root; Postgres copies its key in with the
# owner it requires at start). The CA key never leaves ca-private/.
chmod 644 certs/*.crt; chmod 600 certs/*.key
chmod 700 ca-private; chmod 600 ca-private/ca.key
ok "all certificates verify against the CA"

# Files created here belong to root; hand them to whoever owns the repo folder (Linux/macOS).
owner="$(stat -c '%u:%g' /work)"
chown "$owner" .env 2>/dev/null || true
chown -R "$owner" certs ca-private 2>/dev/null || true

cat <<'EOF'

Init done. Next:
  docker compose up -d          start everything (first start: about a minute)
Then open https://localhost:8443 and create your n8n owner account.
EOF
