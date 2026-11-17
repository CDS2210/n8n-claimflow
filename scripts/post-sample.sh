#!/usr/bin/env bash
# Posts one sample claim by hand, filling in {{DAYS_AGO:n}} dates.
#   ./scripts/post-sample.sh samples/01-windscreen-fast-track.json
# The idempotency key is used as written, so posting the same file twice shows the
# duplicate handling (200 + the original claim_ref).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f "${1:-}" ] || { echo "usage: $0 samples/<file>.json"; exit 1; }
ca="$PWD/certs/ca.crt"; command -v cygpath >/dev/null 2>&1 && ca="$(cygpath -w "$ca")"   # Windows Node needs C: paths
export NODE_EXTRA_CA_CERTS="$ca"     # trust our local CA for HTTPS
port="$(grep -E '^HTTPS_PORT=' .env | cut -d= -f2 | sed 's/[[:space:]]*#.*$//')"
node -e '
const fs = require("fs");
const day = (n) => new Date(Date.now() - n * 864e5).toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" });
const body = fs.readFileSync(process.argv[1], "utf8").replace(/\{\{DAYS_AGO:(-?\d+)\}\}/g, (_, n) => day(Number(n)));
fetch(`https://localhost:${process.argv[2] || 8443}/webhook/claims`, { method: "POST", headers: { "content-type": "application/json" }, body })
  .then(async (r) => console.log(`HTTP ${r.status}\n${JSON.stringify(await r.json(), null, 2)}`))
  .catch((e) => { console.error(e.message); process.exit(1); });' "$1" "$port"
