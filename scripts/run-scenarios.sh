#!/usr/bin/env bash
# ClaimFlow end-to-end tests against the running stack.
#   ./scripts/run-scenarios.sh               reset data, run 13 scenarios + flow checks (LLM_MODE=mock)
#   ./scripts/run-scenarios.sh --keep-data   skip the reset (results may differ: rules use history)
#   ./scripts/run-scenarios.sh --redteam     held-out injection set, any LLM_MODE (a measurement)
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1
command -v docker >/dev/null 2>&1 || export PATH="$PATH:/c/Program Files/Docker/Docker/resources/bin"
command -v node >/dev/null 2>&1 || { echo "Node.js 18+ is required"; exit 1; }
ca="$PWD/certs/ca.crt"; command -v cygpath >/dev/null 2>&1 && ca="$(cygpath -w "$ca")"   # Windows Node needs C: paths
export NODE_EXTRA_CA_CERTS="$ca"     # trust our local CA for HTTPS

mode="$(docker compose exec -T n8n printenv LLM_MODE 2>/dev/null || true)"
[ -n "$mode" ] || { echo "n8n is not running. Start it with: docker compose up -d"; exit 1; }
if [[ " $* " != *" --redteam "* ]] && [ "$mode" != "mock" ]; then
  echo "Scenario assertions need LLM_MODE=mock (running: $mode). Set it in .env and run: docker compose up -d n8n"
  exit 1
fi
if [[ " $* " != *" --keep-data "* ]]; then ./scripts/reset-data.sh; echo; fi
node scripts/run-scenarios.mjs "$@"
