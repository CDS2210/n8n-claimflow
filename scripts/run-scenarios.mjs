// ClaimFlow end-to-end scenario runner. Use ./scripts/run-scenarios.sh (sets up TLS trust,
// checks LLM_MODE and resets the data first). No dependencies beyond Node 18+.
//   node scripts/run-scenarios.mjs            mock-mode scenarios + flow checks (pass/fail)
//   node scripts/run-scenarios.mjs --redteam  held-out injection set, any LLM_MODE (measurement)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/\s+#.*$/, '').trim()]; }));
const BASE = `https://localhost:${ENV.HTTPS_PORT || 8443}`;
const MAIL = `https://localhost:${ENV.MAILPIT_UI_PORT || 8025}`;
const REDTEAM = process.argv.includes('--redteam');
const RUN_ID = Date.now().toString(36);
const started = Date.now();
const startedIso = new Date(started - 1000).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── helpers ────────────────────────────────────────────────────────
const docker = (args) => execFileSync('docker', ['compose', ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sql = (q) => docker(['exec', '-T', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', ENV.CLAIMFLOW_DB_USER, '-d', 'claimflow', '-tA', '-c', q]).trim();
const sqlJson = (q) => JSON.parse(sql(`SELECT coalesce(json_agg(t), '[]'::json) FROM (${q}) t`) || '[]');
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sastDate = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const fill = (body, suffix = RUN_ID) => {
  const json = JSON.stringify(body).replace(/\{\{DAYS_AGO:(-?\d+)\}\}/g, (_, n) => sastDate(Number(n)));
  const b = JSON.parse(json);
  if (b.idempotency_key) b.idempotency_key = `${b.idempotency_key}-${suffix}`;
  return b;
};
async function post(body) {
  const res = await fetch(`${BASE}/webhook/claims`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { /* not json */ }
  return { code: res.status, json };
}
async function get(url) { const r = await fetch(url); let j = null; try { j = await r.json(); } catch { /* */ } return { code: r.status, json: j }; }
async function waitFor(fn, ms = 30000, every = 1500) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(every); }
  return last;
}
const mailSearch = async (q) => (await get(`${MAIL}/api/v1/search?query=${encodeURIComponent(q)}`)).json?.messages || [];
const mailGet = async (id) => (await get(`${MAIL}/api/v1/message/${id}`)).json;
const claimByKey = (key) => sqlJson(`SELECT claim_ref, route, status, ai_status, rule_flags, rejection_reasons FROM claims WHERE idempotency_key = ${lit(key)}`)[0];
const claimByRef = (ref) => sqlJson(`SELECT claim_ref, route, status, reviewer FROM claims WHERE claim_ref = ${lit(ref)}`)[0];
const eventsFor = (ref) => sqlJson(`SELECT event_type FROM claim_events WHERE claim_ref = ${lit(ref)} ORDER BY id`).map((e) => e.event_type);
const C = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', dim: '\x1b[2m', bold: '\x1b[1m' };

// ── red-team measurement ───────────────────────────────────────────
if (REDTEAM) {
  const mode = docker(['exec', '-T', 'n8n', 'printenv', 'LLM_MODE']).trim();
  const model = mode === 'mock' ? 'mock' : docker(['exec', '-T', 'n8n', 'printenv', `${mode.toUpperCase()}_MODEL`]).trim();
  const set = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples/redteam/held-out.json'), 'utf8'));
  console.log(`${C.bold}Red-team run (held-out set) · LLM_MODE=${mode} · model=${model}${C.reset}\n`);
  console.log(' Sample                         Layers fired                         Route          Verdict');
  let caught = 0, attacks = 0, falseAlarms = 0, benign = 0;
  for (const [i, s] of set.entries()) {
    const body = fill({ idempotency_key: `redteam-${i}`, policy_number: 'POL-HOM-100009', channel: 'web',
      claimant: { name: 'Red Team', email: 'redteam@example.com' }, incident_date: '{{DAYS_AGO:2}}', claimed_amount: 5000 + i, description: s.text });
    const r = await post(body);
    const c = r.code === 202 ? claimByKey(body.idempotency_key) : null;
    const layers = (c?.rule_flags || []).map((f) => f.code).filter((x) => /injection|ai_reported/.test(x));
    const hard = layers.some((x) => x === 'prompt_injection_pattern' || x === 'injection_detector');
    let verdict;
    if (s.attack) { attacks++; if (hard) caught++; verdict = hard ? `${C.green}caught${C.reset}` : `${C.red}MISSED${C.reset}`; }
    else { benign++; if (layers.length) falseAlarms++; verdict = layers.length ? `${C.red}FALSE ALARM${C.reset}` : `${C.green}clean${C.reset}`; }
    console.log(` ${s.id.padEnd(30)} ${(layers.join(', ') || '-').padEnd(36)} ${String(c?.route || `HTTP ${r.code}`).padEnd(14)} ${verdict}`);
  }
  console.log(`\n ${C.bold}Attacks caught by hard flags: ${caught}/${attacks} · false alarms: ${falseAlarms}/${benign}${C.reset}  (${Math.round((Date.now() - started) / 1000)} s)`);
  console.log(` ${C.dim}This is a measurement, not a pass/fail gate. Record it in the README with the model used.${C.reset}`);
  process.exit(0);
}

// ── scenarios ──────────────────────────────────────────────────────
const scenarios = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples/scenarios.json'), 'utf8'));
const rows = [];
const results = {};   // file -> { body, response, claim }
const failures = [];
const check = (row, name, ok, detail = '') => { row.checks.push({ name, ok: !!ok }); if (!ok) failures.push(`${row.id} ${row.title}: ${name}${detail ? ` (${detail})` : ''}`); };

console.log(`${C.bold}ClaimFlow scenario run · ${new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })} · LLM_MODE=mock${C.reset}\n`);
for (const s of scenarios) {
  const row = { id: s.file.slice(0, 2), title: s.title, checks: [], http: '', route: '' };
  rows.push(row);
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', s.file), 'utf8'));
  const body = fill(raw);
  const r = await post(body);
  row.http = r.code;
  results[s.file] = { body, response: r.json };
  const e = s.expect;
  check(row, `HTTP ${e.http}`, r.code === e.http, `got ${r.code}`);
  if (e.errorsInclude) for (const msg of e.errorsInclude) check(row, `error lists "${msg}"`, (r.json?.details || []).some((d) => d.includes(msg)));
  if (e.duplicateOf) {
    const original = results[e.duplicateOf]?.response?.claim_ref;
    check(row, 'same claim_ref as original', r.json?.claim_ref && r.json.claim_ref === original, `${r.json?.claim_ref} vs ${original}`);
    check(row, 'duplicate: true', r.json?.duplicate === true);
  }
  if (e.route) {
    check(row, 'no scores in response', r.json && !/score|flag|route|fraud/i.test(JSON.stringify(r.json)));
    check(row, 'signed status_url', /status\?ref=CLM-\d{4}-\d{6}&t=[0-9a-f]{32}$/.test(r.json?.status_url || ''));
    const c = claimByKey(body.idempotency_key);
    results[s.file].claim = c;
    row.route = c?.route || '';
    check(row, `route ${e.route}`, c?.route === e.route, `got ${c?.route}`);
    check(row, `status ${e.status}`, c?.status === e.status, `got ${c?.status}`);
    const flags = (c?.rule_flags || []).map((f) => f.code);
    if (e.flags) check(row, 'no rule flags', flags.length === 0, flags.join(','));
    for (const f of e.flagsInclude || []) check(row, `flag ${f}`, flags.includes(f), flags.join(','));
    if (e.aiStatus) check(row, `ai_status ${e.aiStatus}`, c?.ai_status === e.aiStatus, `got ${c?.ai_status}`);
    for (const reason of e.reasons || []) check(row, `reason ${reason}`, (c?.rejection_reasons || []).includes(reason));
  }
  process.stdout.write(`${C.dim}.${C.reset}`);
}

// Async work (emails, audit events) happens after the 202: wait for it
for (const s of scenarios) {
  const row = rows.find((x) => x.id === s.file.slice(0, 2));
  const res = results[s.file]; const ref = res.claim?.claim_ref; const e = s.expect;
  if (!ref) continue;
  if (e.email) {
    const found = await waitFor(async () => (await mailSearch(`to:${res.body.claimant.email} subject:"${ref}"`)).find((m) => m.Subject.includes(e.email)));
    check(row, `claimant email "${e.email}"`, !!found);
  }
  if (e.fraudEmail) {
    const found = await waitFor(async () => (await mailSearch(`to:${ENV.CLAIMFLOW_FRAUD_TEAM_EMAIL} subject:"${ref}"`)).find((m) => m.Subject.startsWith('[Fraud review]')));
    check(row, 'fraud-team review email', !!found);
    res.fraudMailId = found?.ID;
  }
  if (e.http === 202) {
    const ev = await waitFor(async () => { const x = eventsFor(ref); return x.includes('notification_sent') ? x : null; }, 20000) || eventsFor(ref);
    check(row, 'audit trail complete', ['received', 'ai_analysed', 'routed', 'notification_sent'].every((t) => ev.includes(t)), ev.join(','));
  }
  process.stdout.write(`${C.dim}.${C.reset}`);
}

// ── flow checks ────────────────────────────────────────────────────
const flow = (id, title) => { const row = { id, title, checks: [], http: '-', route: '-' }; rows.push(row); return row; };
const r03 = results['03-suspicious-theft.json'], r07 = results['07-prompt-injection.json'], r13 = results['13-paraphrased-injection.json'];

{ const row = flow('F1', 'status API: signed link');
  const r = await get(r03.response?.status_url || `${BASE}/webhook/claims/status`);
  row.http = r.code;
  check(row, 'HTTP 200', r.code === 200, `got ${r.code}`);
  check(row, 'fraud review shown as under_review', r.json?.status === 'under_review', r.json?.status);
  check(row, 'no internal data', r.json && !/fraud|score|flag|pending_|reviewer/i.test(JSON.stringify(r.json))); }
{ const row = flow('F2', 'status API: bad token / bad ref');
  const url = r03.response?.status_url || '';
  const bad = await get(url.replace(/t=([0-9a-f]+)$/, (_, t) => `t=${t.slice(0, -1)}${t.endsWith('0') ? '1' : '0'}`));
  const none = await get(url.replace(/&t=.*$/, ''));
  const junk = await get(`${BASE}/webhook/claims/status?ref=${encodeURIComponent("1' OR 1=1")}`);
  row.http = `${bad.code}/${junk.code}`;
  check(row, 'tampered token 404', bad.code === 404);
  check(row, 'missing token 404 (same body)', none.code === 404 && JSON.stringify(none.json) === JSON.stringify(bad.json));
  check(row, 'malformed ref 400', junk.code === 400); }

async function decide(res, fields) {
  const msg = await mailGet(res.fraudMailId);
  const link = (msg?.HTML || '').match(/href="([^"]*form-waiting[^"]*)"/)?.[1]?.replace(/&amp;/g, '&');
  if (!link) return { code: 0, link };
  const fd = new FormData();
  Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
  const r = await fetch(link, { method: 'POST', body: fd });
  return { code: r.status, link };
}
const NOTE = 'INTERNAL ONLY: tracker data contradicts the claimant - do not share';
const reviews = [
  { id: 'F3', title: 'fraud review: approve', res: r03, decision: 'Approve for assessment', status: 'approved_for_assessment', email: 'approved for assessment' },
  { id: 'F4', title: 'fraud review: reject', res: r07, decision: 'Reject', status: 'rejected', email: 'Update on your claim' },
  { id: 'F5', title: 'fraud review: more info', res: r13, decision: 'Request more information', status: 'more_info_required', email: 'more information',
    message: 'Please send the hotel incident report and your police case number.' },
];
for (const rv of reviews) {
  const row = flow(rv.id, rv.title);
  const ref = rv.res.claim?.claim_ref;
  const sub = await decide(rv.res, { 'field-1': rv.decision, 'field-2': 'Fraud.Lead@AcmeCover.example', 'field-3': NOTE, 'field-4': rv.message || '' });
  rv.link = sub.link; row.http = sub.code;
  check(row, 'form submitted', sub.code === 200, `HTTP ${sub.code}`);
  const c = await waitFor(async () => { const x = claimByRef(ref); return x?.status === rv.status ? x : null; }, 30000);
  check(row, `status ${rv.status}`, !!c, claimByRef(ref)?.status);
  check(row, 'reviewer recorded', c?.reviewer === 'fraud.lead@acmecover.example');
  check(row, 'review_decision event', eventsFor(ref).includes('review_decision'));
  const m = await waitFor(async () => (await mailSearch(`to:${rv.res.body.claimant.email} subject:"${ref}"`)).find((x) => x.Subject.includes(rv.email)));
  check(row, `claimant email "${rv.email}"`, !!m);
  if (m) {
    const full = await mailGet(m.ID);
    check(row, 'internal notes not leaked', !full.Text.includes('INTERNAL ONLY') && !full.HTML.includes('INTERNAL ONLY'));
    if (rv.message) check(row, 'reviewer message delivered', full.Text.includes(rv.message));
  }
}
{ const row = flow('F6', 'double submit (reuse link)');
  const before = claimByRef(r03.claim?.claim_ref)?.status;
  const fd = new FormData(); fd.append('field-1', 'Reject'); fd.append('field-2', 'someone@acmecover.example'); fd.append('field-3', 'late');
  const r = reviews[0].link ? await fetch(reviews[0].link, { method: 'POST', body: fd }) : { status: 0 };
  await sleep(3000);
  row.http = r.status;
  // Normally the finished run is deleted, so n8n answers 404. In demo mode the run is kept and
  // n8n shows its "Form Submitted" page instead (200), still without resuming anything.
  const demoKept = docker(['exec', '-T', 'n8n', 'printenv', 'CLAIMFLOW_DEMO_MODE']).trim().toLowerCase() === 'true';
  check(row, demoKept ? 'reused link not resumed (404 or "already submitted")' : 'reused link rejected (404)',
    r.status === 404 || (demoKept && r.status === 200), `HTTP ${r.status}`);
  check(row, 'claim unchanged', claimByRef(r03.claim?.claim_ref)?.status === before);
  check(row, 'only one review_decision event', eventsFor(r03.claim?.claim_ref).filter((e) => e === 'review_decision').length === 1); }
{ const row = flow('F7', 'no tipping off (all claimant emails)');
  const all = (await get(`${MAIL}/api/v1/messages?limit=200`)).json?.messages || [];
  const claimant = all.filter((m) => m.To.every((t) => !t.Address.endsWith('@acmecover.example')));
  let leaks = 0;
  for (const m of claimant) { const full = await mailGet(m.ID); if (/fraud|risk|score|flag|suspici/i.test(full.Text + full.Subject)) leaks++; }
  check(row, `${claimant.length} claimant emails checked`, claimant.length >= 10, `only ${claimant.length}`);
  check(row, 'no fraud/risk/score/flag wording', leaks === 0, `${leaks} leaking`); }
{ const row = flow('F8', 'PI encrypted at rest');
  const dump = docker(['exec', '-T', 'postgres', 'pg_dump', '-U', ENV.CLAIMFLOW_DB_USER, '-d', 'claimflow', '--data-only']);
  const needles = [];
  for (const s of scenarios) { const b = results[s.file].body; if (b.claimant) needles.push(b.claimant.name, b.claimant.email, b.claimant.phone); }
  const found = [...new Set(needles.filter(Boolean))].filter((n) => dump.toLowerCase().includes(n.toLowerCase()));
  check(row, 'no sample name/email/phone in a DB dump', found.length === 0, found.slice(0, 3).join(', ')); }
{ const row = flow('F9', 'daily ops report');
  const expected = Number(sql(`SELECT count(*) FROM claims WHERE reported_at >= ${lit(startedIso)}`));
  let ran = true;
  try { docker(['exec', '-T', '-e', 'N8N_RUNNERS_BROKER_PORT=5699', 'n8n', 'n8n', 'execute', '--id=cfDailyReport001']); }
  catch (err) {
    ran = false;
    const line = String(err.stdout || err.message).split('\n').find((l) => /error/i.test(l));
    failures.push(`F9 report run failed: ${line || 'see n8n logs'}`);
  }
  check(row, 'report workflow ran', ran);
  const m = await waitFor(async () => (await mailSearch(`to:${ENV.CLAIMFLOW_OPS_EMAIL} subject:"daily report"`))[0]);
  check(row, 'report emailed to ops', !!m);
  check(row, `report counts ${expected} claims`, m?.Subject.includes(`: ${expected} claims`), m?.Subject); }
// Demo mode (workflow 07): the trace page and the login-gated form exist only when it's on.
const DEMO = docker(['exec', '-T', 'n8n', 'printenv', 'CLAIMFLOW_DEMO_MODE']).trim().toLowerCase() === 'true';
const linkKey = Buffer.from(ENV.CLAIMFLOW_STATUS_LINK_KEY || '', 'base64');
const traceToken = (ref) => crypto.createHmac('sha256', linkKey).update(`trace:${ref}`, 'utf8').digest('hex').slice(0, 32);
const traceUrl = (ref, t = traceToken(ref)) => `${BASE}/webhook/demo/trace?ref=${encodeURIComponent(ref)}&t=${t}`;
{ const row = flow('F10', `demo mode ${DEMO ? 'on' : 'off'}: trace page + form`);
  const ref = r03.claim?.claim_ref;
  const page = await fetch(traceUrl(ref)); const html = await page.text();
  const statusTok = (r03.response?.status_url || '').match(/t=([0-9a-f]+)/)?.[1];
  const withStatusTok = await fetch(traceUrl(ref, statusTok));
  const form = await fetch(`${BASE}/form/claim-demo`, { redirect: 'manual' });
  row.http = `${page.status}/${form.status}`;
  if (DEMO) {
    check(row, 'trace page 200 (HTML)', page.status === 200 && /text\/html/.test(page.headers.get('content-type')), `HTTP ${page.status}`);
    check(row, 'shows route, flags, AI model and audit trail', html.includes(ref) && html.includes('Fraud review') && html.includes('new_policy') && html.includes('ai_analysed') && html.includes('mock'));
    check(row, 'shows the review decision', html.includes('approve') && html.includes('fraud.lead@acmecover.example'));
    check(row, 'no plaintext PI', !html.includes(r03.body.claimant.email) && !html.includes(r03.body.claimant.name));
    check(row, 'form needs an n8n login', form.status === 302 && /authorize|signin/.test(form.headers.get('location') || ''), `HTTP ${form.status}`);
  } else {
    check(row, 'trace page 404 when off', page.status === 404, `HTTP ${page.status}`);
    check(row, 'form 404 when off', form.status === 404, `HTTP ${form.status}`);
  }
  const bad = await fetch(traceUrl(ref, '0'.repeat(32)));
  check(row, 'tampered token 404', bad.status === 404, `HTTP ${bad.status}`);
  check(row, "claimant's status token can't open it", withStatusTok.status === 404, `HTTP ${withStatusTok.status}`); }
{ const row = flow('F11', `execution data (demo ${DEMO ? 'keeps' : 'drops'} runs)`);
  const n = Number(docker(['exec', '-T', 'postgres', 'psql', '-U', ENV.N8N_DB_USER, '-d', 'n8n', '-tA', '-c',
    `SELECT count(*) FROM execution_entity WHERE "workflowId" = 'pY62sSjeshgn8nDx' AND status = 'success' AND "deletedAt" IS NULL AND "startedAt" >= ${lit(startedIso)}`]).trim());
  check(row, DEMO ? 'successful intake runs kept' : 'successful intake runs not kept', DEMO ? n > 0 : n === 0, `${n} kept`); }
// Sandbox policies (demo form page 2). The suite can't log in to the form, so it runs the
// workflow's own Create_Sandbox_PG statement (read from the JSON, so it can't drift), then posts
// claims through the real intake API. The form pages themselves are covered in docs/testing.md.
{ const row = flow('F12', 'sandbox policies (SQL + rules)');
  const wf = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows/07-demo-portal.json'), 'utf8'));
  const createSql = wf.nodes.find((n) => n.name === 'Create_Sandbox_PG').parameters.query;
  const require = createRequire(import.meta.url);
  const { piiKeys, encryptField, blindIndex } = require('./lib/pii-crypto.js');
  const keys = piiKeys(ENV);
  const holder = { name: 'Sandbox Tester', email: `sandbox.${RUN_ID}@example.com` };
  const makePolicy = (p) => {
    const args = [encryptField(holder.name, 'name', keys), encryptField(holder.email, 'email', keys), blindIndex(holder.email, keys), null,
      p.product, p.sum, 0, sastDate(p.startAgo), sastDate(p.endAgo), p.status, JSON.stringify(p.prior.map(sastDate))];
    const q = `PREPARE sbx AS ${createSql.replace(/;\s*$/, '')}; EXECUTE sbx(${args.map((a) => (a === null ? 'NULL' : lit(a))).join(', ')});`;
    return (sql(q).match(/POL-SBX-\d{6}/) || [''])[0];   // psql also prints the PREPARE tag
  };
  const claimOn = async (policy, tag) => post({ idempotency_key: `sandbox-test-${tag}-${RUN_ID}`, policy_number: policy, channel: 'web',
    claimant: holder, incident_date: sastDate(2), claimed_amount: 3000, currency: 'ZAR', description: 'A stone hit my windscreen on the N1 and cracked it.' });
  const codes = (ref) => (sqlJson(`SELECT rule_flags FROM claims WHERE claim_ref = ${lit(ref)}`)[0]?.rule_flags || []).map((f) => f.code);

  const fresh = makePolicy({ product: 'motor', sum: 180000, startAgo: 10, endAgo: -355, status: 'active', prior: [8, 5] });
  const old = makePolicy({ product: 'home', sum: 500000, startAgo: 700, endAgo: -300, status: 'active', prior: [450, 60] });
  const lapsed = makePolicy({ product: 'travel', sum: 50000, startAgo: 400, endAgo: 35, status: 'lapsed', prior: [] });
  check(row, 'policies numbered POL-SBX-…', [fresh, old, lapsed].every((p) => /^POL-SBX-\d{6}$/.test(p)), `${fresh}, ${old}, ${lapsed}`);
  check(row, 'earlier claims stored as closed history', Number(sql(`SELECT count(*) FROM claims WHERE policy_number = ${lit(fresh)} AND status = 'closed'`)) === 2);
  check(row, 'holder PI encrypted', sql(`SELECT holder_name_enc LIKE 'v1:%' FROM policies WHERE policy_number = ${lit(fresh)}`) === 't');
  const a = await claimOn(fresh, 'fresh');
  const aFlags = codes(a.json?.claim_ref);
  check(row, 'new policy + 2 recent claims: new_policy, frequent_claimant', a.code === 202 && aFlags.includes('new_policy') && aFlags.includes('frequent_claimant'), aFlags.join(','));
  const b = await claimOn(old, 'old');
  const bFlags = codes(b.json?.claim_ref);
  check(row, 'claim older than 12 months not counted', b.code === 202 && !bFlags.includes('frequent_claimant') && !bFlags.includes('new_policy'), bFlags.join(','));
  const c = await claimOn(lapsed, 'lapsed');
  check(row, 'lapsed sandbox policy: 422 policy_not_active', c.code === 422 && (c.json?.reasons || []).includes('policy_not_active'), `${c.code} ${JSON.stringify(c.json?.reasons)}`);
  row.http = `${a.code}/${b.code}/${c.code}`;
  if (DEMO) {
    const page = await (await fetch(traceUrl(a.json?.claim_ref))).text();
    check(row, 'trace page shows the sandbox policy and its history', page.includes('Sandbox policy and claim history') && page.includes(fresh) && (page.match(/<b>counted<\/b>/g) || []).length === 2);
    const pageOld = await (await fetch(traceUrl(b.json?.claim_ref))).text();
    check(row, 'trace page marks the old claim "not counted"', pageOld.includes('too old, not counted'));
  } }
{ const row = flow('F13', 'no unexpected workflow errors');
  const n = Number(sql(`SELECT count(*) FROM workflow_errors WHERE created_at >= ${lit(startedIso)}`));
  check(row, '0 errors logged during the run', n === 0, `${n} logged`); }

// ── report ─────────────────────────────────────────────────────────
console.log('\n\n #    Scenario                              HTTP     Route           Checks   Result');
let total = 0, passed = 0;
for (const r of rows) {
  const ok = r.checks.filter((c) => c.ok).length; total += r.checks.length; passed += ok;
  const res = ok === r.checks.length ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
  console.log(` ${r.id.padEnd(4)} ${r.title.padEnd(37)} ${String(r.http).padEnd(8)} ${String(r.route || '-').padEnd(15)} ${`${ok}/${r.checks.length}`.padEnd(8)} ${res}`);
}
const secs = Math.round((Date.now() - started) / 1000);
console.log(`\n ${passed === total ? C.green : C.red}${C.bold}${passed}/${total} checks passed${C.reset} in ${secs} s`);
if (failures.length) { console.log(`\n${C.red}Failures:${C.reset}`); failures.forEach((f) => console.log(`  - ${f}`)); }
process.exit(passed === total ? 0 : 1);
