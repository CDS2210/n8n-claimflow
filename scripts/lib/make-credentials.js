// Builds the n8n credentials file from environment variables. Runs INSIDE the n8n
// container (called by scripts/deploy.js in the deploy container), so secrets never touch the host disk:
//   node /scripts/lib/make-credentials.js /tmp/creds.json && n8n import:credentials ...
// Credential IDs are fixed so the workflow JSON can reference them.
const fs = require('fs');
const out = process.argv[2];
const env = process.env;
const key = (v) => (v && v.trim() ? v.trim() : 'not-configured');   // placeholder keeps workflows publishable

const credentials = [
  {
    id: 'cfPostgresDb0001', name: 'ClaimFlow DB', type: 'postgres',
    data: {
      host: 'postgres', port: 5432, database: 'claimflow',
      user: env.CLAIMFLOW_DB_USER, password: env.CLAIMFLOW_DB_PASSWORD,
      ssl: 'require', allowUnauthorizedCerts: false,
      caCertificate: fs.readFileSync('/certs/ca.crt', 'utf8'),   // verify the server, not just encrypt
    },
  },
  { id: 'cfOpenAiApi00001', name: 'ClaimFlow OpenAI', type: 'openAiApi',
    data: { apiKey: key(env.OPENAI_API_KEY), url: 'https://api.openai.com/v1' } },
  { id: 'cfAnthropic00001', name: 'ClaimFlow Anthropic', type: 'anthropicApi',
    data: { apiKey: key(env.ANTHROPIC_API_KEY), url: 'https://api.anthropic.com' } },
  { id: 'cfOllamaApi00001', name: 'ClaimFlow Ollama', type: 'ollamaApi',
    data: { baseUrl: 'http://ollama:11434' } },
  // Mailpit: STARTTLS required (secure:false + STARTTLS upgrade); its certificate is trusted via
  // NODE_EXTRA_CA_CERTS. Mailpit accepts any login; a real provider would use a real one.
  { id: 'cfSmtpMailpit001', name: 'ClaimFlow SMTP', type: 'smtp',
    data: { host: 'mailpit', port: 1025, secure: false, disableStartTls: false,
      user: 'claimflow', password: 'mailpit-accepts-any-login', hostName: '' } },
];

fs.writeFileSync(out, JSON.stringify(credentials), { mode: 0o600 });
console.log(`wrote ${credentials.length} credentials: ${credentials.map((c) => c.name).join(', ')}`);
