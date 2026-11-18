// ── ClaimFlow signed status links ─────────────────────────────────
// Claim references are sequential, so the Status API needs proof the caller was given the
// link: t = first 32 hex chars of HMAC-SHA256(CLAIMFLOW_STATUS_LINK_KEY, claim_ref).
// Copied into the Code nodes that build or check links (same pattern as pii-crypto.js).
const linkCrypto = require('crypto');

function statusToken(claimRef, env) {
  const key = Buffer.from(String(env.CLAIMFLOW_STATUS_LINK_KEY || ''), 'base64');
  if (key.length < 32) throw new Error('CLAIMFLOW_STATUS_LINK_KEY must be at least 32 random bytes, base64-encoded');
  return linkCrypto.createHmac('sha256', key).update(`status:${claimRef}`, 'utf8').digest('hex').slice(0, 32);
}

function statusUrl(claimRef, env) {
  return `${env.WEBHOOK_URL}webhook/claims/status?ref=${encodeURIComponent(claimRef)}&t=${statusToken(claimRef, env)}`;
}

// Constant-time comparison so response timing doesn't reveal how much of a token matched.
function statusTokenValid(claimRef, token, env) {
  const expected = Buffer.from(statusToken(claimRef, env), 'utf8');
  const given = Buffer.from(String(token || ''), 'utf8');
  return given.length === expected.length && linkCrypto.timingSafeEqual(given, expected);
}
// Demo mode only: the Claim Trace page shows internal signals (scores, flags), so it gets its
// own token. Same key, different message ("trace:" vs "status:"), so a claimant's status link
// can never open the trace page.
function traceToken(claimRef, env) {
  const key = Buffer.from(String(env.CLAIMFLOW_STATUS_LINK_KEY || ''), 'base64');
  if (key.length < 32) throw new Error('CLAIMFLOW_STATUS_LINK_KEY must be at least 32 random bytes, base64-encoded');
  return linkCrypto.createHmac('sha256', key).update(`trace:${claimRef}`, 'utf8').digest('hex').slice(0, 32);
}
function traceUrl(claimRef, env) {
  return `${env.WEBHOOK_URL}webhook/demo/trace?ref=${encodeURIComponent(claimRef)}&t=${traceToken(claimRef, env)}`;
}
function traceTokenValid(claimRef, token, env) {
  const expected = Buffer.from(traceToken(claimRef, env), 'utf8');
  const given = Buffer.from(String(token || ''), 'utf8');
  return given.length === expected.length && linkCrypto.timingSafeEqual(given, expected);
}
// ── end of shared code ── (the line below is stripped when copied into n8n)
module.exports = { statusToken, statusUrl, statusTokenValid, traceToken, traceUrl, traceTokenValid };
