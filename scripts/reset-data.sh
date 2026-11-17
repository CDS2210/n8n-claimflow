#!/usr/bin/env bash
# Resets ClaimFlow's application data to the seed state (used by run-scenarios.sh).
#   ./scripts/reset-data.sh
# - drops and reloads the claimflow schema + seed data, re-encrypts the seed PI
# - keeps the claim number sequence going, so a claim reference is never reused
# - cancels fraud reviews still waiting in n8n (their claims no longer exist)
# - empties the Mailpit inbox
# Does NOT touch n8n's own data: your account, workflows and credentials stay.
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1
command -v docker >/dev/null 2>&1 || export PATH="$PATH:/c/Program Files/Docker/Docker/resources/bin"
DC="docker compose"
psql_app() { $DC exec -T postgres psql -v ON_ERROR_STOP=1 -q -U "$(grep -E '^CLAIMFLOW_DB_USER=' .env | cut -d= -f2)" -d claimflow "$@"; }
psql_n8n() { $DC exec -T postgres psql -v ON_ERROR_STOP=1 -q -U "$(grep -E '^N8N_DB_USER=' .env | cut -d= -f2)" -d n8n "$@"; }

next_ref="$(psql_app -tAc "SELECT CASE WHEN to_regclass('public.claim_ref_seq') IS NULL THEN 1 ELSE (SELECT last_value + 1 FROM claim_ref_seq) END")"

psql_app -c "SET client_min_messages = warning; DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
psql_app -f /claimflow-sql/schema.sql >/dev/null
psql_app -f /claimflow-sql/seed.sql >/dev/null
# Seed claims took the first numbers; continue after whichever is higher.
psql_app -tAc "SELECT setval('claim_ref_seq', GREATEST($next_ref, (SELECT last_value + 1 FROM claim_ref_seq)), false)" >/dev/null
$DC exec -T n8n node /scripts/encrypt-seed-pii.js

# Waiting fraud reviews refer to claims that no longer exist: cancel them.
cancelled="$(psql_n8n -tAc "WITH d AS (DELETE FROM execution_entity WHERE \"workflowId\" = 'cfFraudReview001' AND status = 'waiting' RETURNING 1) SELECT count(*) FROM d")"

CURL=(-s --cacert certs/ca.crt); curl -V | grep -qi schannel && CURL+=(--ssl-revoke-best-effort)
curl "${CURL[@]}" -X DELETE "https://localhost:$(grep -E '^MAILPIT_UI_PORT=' .env | cut -d= -f2 | sed 's/[[:space:]]*#.*$//')/api/v1/messages" >/dev/null

echo "claim data reset to seed (next claim number $next_ref); cancelled $cancelled waiting fraud reviews; Mailpit emptied"
