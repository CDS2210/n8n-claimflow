// Encrypts the seed personal information (db/seed.sql -> seed_pii table) into the
// encrypted columns, then drops seed_pii. Runs INSIDE the n8n container (it has the
// keys in its environment and the pg driver), called by scripts/setup.sh:
//   docker compose exec -T n8n node /scripts/encrypt-seed-pii.js
// Safe to re-run: does nothing once seed_pii is gone.
const fs = require('fs');
const path = require('path');
const { piiKeys, encryptField, decryptField, blindIndex } = require('./lib/pii-crypto.js');
const { Client } = require(require.resolve('pg', { paths: ['/usr/local/lib/node_modules/n8n'] }));

(async () => {
  const keys = piiKeys(process.env);
  const db = new Client({
    host: 'postgres', port: 5432, database: 'claimflow',
    user: process.env.CLAIMFLOW_DB_USER, password: process.env.CLAIMFLOW_DB_PASSWORD,
    ssl: { ca: fs.readFileSync('/certs/ca.crt', 'utf8'), rejectUnauthorized: true, servername: 'postgres' },
  });
  await db.connect();
  try {
    const { rows: [{ exists }] } = await db.query("SELECT to_regclass('public.seed_pii') IS NOT NULL AS exists");
    if (!exists) { console.log('seed PII already encrypted (seed_pii not present) - nothing to do'); return; }

    await db.query('BEGIN');
    const { rows } = await db.query('SELECT policy_number, name, email, phone FROM seed_pii ORDER BY policy_number');
    let claims = 0;
    for (const r of rows) {
      const enc = {
        name: encryptField(r.name, 'name', keys),
        email: encryptField(r.email, 'email', keys),
        hmac: blindIndex(r.email, keys),
        phone: encryptField(r.phone, 'phone', keys),
      };
      await db.query(
        `UPDATE policies SET holder_name_enc = $2, holder_email_enc = $3, holder_email_hmac = $4, holder_phone_enc = $5
          WHERE policy_number = $1`, [r.policy_number, enc.name, enc.email, enc.hmac, enc.phone]);
      // Seed claims were made by the policy holder; each gets its own ciphertext (fresh IV).
      const res = await db.query(
        `UPDATE claims SET claimant_name_enc = $2, claimant_email_enc = $3, claimant_email_hmac = $4, claimant_phone_enc = $5
          WHERE policy_number = $1 AND idempotency_key LIKE 'seed-%'`,
        [r.policy_number, encryptField(r.name, 'name', keys), encryptField(r.email, 'email', keys), enc.hmac,
          encryptField(r.phone, 'phone', keys)]);
      claims += res.rowCount;
    }
    await db.query('DROP TABLE seed_pii');

    // Verify before committing: every row encrypted, and a round trip decrypts.
    const { rows: [chk] } = await db.query(
      `SELECT (SELECT count(*) FROM policies WHERE holder_email_enc IS NULL)::int AS policies_missing,
              (SELECT count(*) FROM claims   WHERE claimant_email_enc IS NULL)::int AS claims_missing,
              (SELECT holder_email_enc FROM policies ORDER BY policy_number LIMIT 1) AS sample`);
    if (chk.policies_missing || chk.claims_missing) throw new Error(`unencrypted rows remain: ${JSON.stringify(chk)}`);
    const sample = decryptField(chk.sample, 'email', keys);
    if (!sample.includes('@')) throw new Error('round-trip decrypt check failed');
    await db.query('COMMIT');
    console.log(`encrypted PII for ${rows.length} policies and ${claims} seed claims; seed_pii dropped; round trip OK`);
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await db.end();
  }
})().catch((err) => { console.error('encrypt-seed-pii failed:', err.message); process.exit(1); });
