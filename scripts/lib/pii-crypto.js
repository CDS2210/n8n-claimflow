// ── ClaimFlow PII crypto ──────────────────────────────────────────
// Single source of truth for field-level encryption. Used by:
//   * the Encrypt_PII_Func Code node (this source is copied into the workflow)
//   * scripts/encrypt-seed-pii.js (require()d directly)
// Format: v1:<iv b64>:<auth tag b64>:<ciphertext b64>   (AES-256-GCM)
// The field name ("name" | "email" | "phone") is bound as associated data, so a
// ciphertext moved to a different column will not decrypt. See docs/security.md.
const crypto = require('crypto');

function piiKeys(env) {
  const key = Buffer.from(String(env.CLAIMFLOW_PII_KEY || ''), 'base64');
  const hmacKey = Buffer.from(String(env.CLAIMFLOW_PII_HMAC_KEY || ''), 'base64');
  if (key.length !== 32) throw new Error('CLAIMFLOW_PII_KEY must be 32 random bytes, base64-encoded');
  if (hmacKey.length !== 32) throw new Error('CLAIMFLOW_PII_HMAC_KEY must be 32 random bytes, base64-encoded');
  if (key.equals(hmacKey)) throw new Error('CLAIMFLOW_PII_KEY and CLAIMFLOW_PII_HMAC_KEY must differ');
  return { v1: key, hmacKey };
}

function encryptField(value, field, keys) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keys.v1, iv);
  cipher.setAAD(Buffer.from(field, 'utf8'));
  const ct = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function decryptField(token, field, keys) {
  if (token === null || token === undefined) return null;
  const [version, iv, tag, ct] = String(token).split(':');
  const key = keys[version];
  if (!key || !iv || !tag || ct === undefined) throw new Error(`Unsupported or malformed ciphertext (${version})`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(field, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

// Deterministic, non-reversible lookup key for exact-match email searches.
function blindIndex(email, keys) {
  return crypto.createHmac('sha256', keys.hmacKey).update(String(email).trim().toLowerCase(), 'utf8').digest('hex');
}
// ── end of shared code ── (the line below is stripped when copied into n8n)
module.exports = { piiKeys, encryptField, decryptField, blindIndex };
