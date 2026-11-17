#!/usr/bin/env bash
# Runs the Daily Ops Report now (instead of waiting for 07:00) and emails it to ops (Mailpit).
#   ./scripts/run-report.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1
# The CLI runs the workflow in its own process; give its task runner a free port so it
# doesn't clash with the running n8n instance.
docker compose exec -T -e N8N_RUNNERS_BROKER_PORT=5699 n8n \
  n8n execute --id=cfDailyReport001 2>&1 | grep -viE 'migration lock|license SDK|Postgres 16 is outside|SSL_CA_FILE' | tail -5
echo "Report sent to the ops inbox: https://localhost:$(grep -E '^MAILPIT_UI_PORT=' .env | cut -d= -f2 | sed 's/[[:space:]]*#.*$//')"
