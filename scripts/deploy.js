// ClaimFlow deploy. Runs INSIDE the one-shot `deploy` container (the n8n image), started by
// every `docker compose up -d` once n8n is healthy. Safe to re-run.
//   1. creates the n8n credentials from the environment (secrets never touch disk outside /tmp)
//   2. encrypts the seed personal information (first run only)
//   3. imports every workflow in /workflows and publishes them in dependency order
//      (demo mode: also publishes the Demo Portal and keeps successful runs of the claim workflows)
//   4. LLM_MODE=ollama: pulls the model into the ollama service if it isn't there yet
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const env = process.env;
const ok = (m) => console.log(`    ok  ${m}`);
const log = (m) => console.log(`\n==> ${m}`);
const die = (m) => { console.error(`\nERROR: ${m}`); process.exit(1); };
// n8n CLI output includes noisy notices; keep it readable.
const n8n = (...args) => {
  let out;
  try { out = execFileSync('n8n', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (err) { out = `${err.stdout || ''}${err.stderr || ''}`; }
  return out.split('\n').filter((l) => !/migration lock|license SDK|Postgres 16 is outside/i.test(l)).join('\n');
};

(async () => {
  // ── 1. Credentials ──
  log('n8n credentials');
  const credFile = '/tmp/creds.json';
  const old = process.umask(0o077);
  execFileSync('node', ['/scripts/lib/make-credentials.js', credFile], { stdio: 'inherit' });
  process.umask(old);
  const imp = n8n('import:credentials', `--input=${credFile}`);
  fs.rmSync(credFile, { force: true });
  if (!/imported/i.test(imp)) die(`could not import credentials:\n${imp}`);
  ok('credentials imported');

  // ── 2. Seed PII ──
  log('Seed personal information');
  execFileSync('node', ['/scripts/encrypt-seed-pii.js'], { stdio: 'inherit' });

  // ── 3. Workflows ──
  log('Importing and publishing workflows');
  const DEMO_ID = 'cfDemoPortal0001';
  const DEMO_KEEP_RUNS = ['pY62sSjeshgn8nDx', 'cfFraudReview001', 'cfNotifications1'];
  const demo = String(env.CLAIMFLOW_DEMO_MODE || '').toLowerCase() === 'true';
  const files = fs.readdirSync('/workflows').filter((f) => /^\d.*\.json$/.test(f)).sort();
  const wfs = files.map((f) => ({ file: path.join('/workflows', f), ...JSON.parse(fs.readFileSync(path.join('/workflows', f), 'utf8')) }));
  // Import everything first: a workflow can't be published before the sub-workflows it calls exist.
  for (const w of wfs) {
    n8n('unpublish:workflow', `--id=${w.id}`);          // republishing requires unpublish first
    let input = w.file;
    const keep = demo && DEMO_KEEP_RUNS.includes(w.id);
    if (keep) {
      const copy = JSON.parse(fs.readFileSync(w.file, 'utf8'));
      copy.settings.saveDataSuccessExecution = 'all';
      input = '/tmp/wf-demo.json';
      fs.writeFileSync(input, JSON.stringify(copy));
    }
    const out = n8n('import:workflow', `--input=${input}`);
    if (keep) fs.rmSync(input, { force: true });
    if (!/imported/i.test(out)) die(`could not import ${path.basename(w.file)}:\n${out}`);
    ok(`imported: ${w.name}${keep ? ' (demo mode: keeps successful executions)' : ''}`);
  }
  // n8n won't publish a workflow until every sub-workflow it calls is published: publish in
  // passes, and anything blocked waits for the next pass.
  let pending = wfs.filter((w) => {
    if (w.id === DEMO_ID && !demo) { ok(`not published: ${w.name} (CLAIMFLOW_DEMO_MODE is not true)`); return false; }
    return true;
  });
  while (pending.length) {
    const blocked = []; let lastErr = '';
    for (const w of pending) {
      const out = n8n('publish:workflow', `--id=${w.id}`);
      if (/which is not published/i.test(out)) { blocked.push(w); lastErr = out; }
      else if (/failed|cannot publish/i.test(out)) die(`could not publish '${w.name}' (${w.id}):\n${out}`);
      else ok(`published: ${w.name}`);
    }
    if (blocked.length === pending.length) die(`publishing made no progress (missing or circular sub-workflow references):\n${lastErr}`);
    pending = blocked;
  }

  // ── 4. Local LLM ──
  if (env.LLM_MODE === 'ollama') {
    log('Local LLM (Ollama)');
    const model = env.OLLAMA_MODEL;
    let tags;
    for (let i = 0; i < 30 && !tags; i++) {
      try { tags = await (await fetch('http://ollama:11434/api/tags')).json(); }
      catch { await new Promise((r) => setTimeout(r, 2000)); }
    }
    if (!tags) die('LLM_MODE=ollama but the ollama service is not running. Set COMPOSE_PROFILES=ollama in .env, then: docker compose up -d');
    if ((tags.models || []).some((m) => m.name === model || m.model === model)) ok(`model ${model} already present`);
    else {
      console.log(`    pulling ${model} (first time only, can take a few minutes)...`);
      const r = await fetch('http://ollama:11434/api/pull', { method: 'POST', body: JSON.stringify({ model, stream: false }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.status !== 'success') die(`could not pull ${model}: ${body.error || r.status}`);
      ok(`pulled ${model}`);
    }
  }
  console.log('\nDeploy done.');
})().catch((err) => die(err.stack || err.message));
