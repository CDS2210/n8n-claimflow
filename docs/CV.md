# ClaimFlow: CV and interview notes

Everything below describes what the system **does** and what was **measured while building it**.
There are no usage or business-impact numbers, because this is a portfolio project with fictional
data. Don't add any.

## CV bullets (pick one per CV, by role)

**General (one line)**
- Built ClaimFlow, an AI-assisted insurance claims intake and triage pipeline in n8n (7 workflows,
  PostgreSQL, Docker), combining LLM analysis with deterministic rules, human fraud review and a
  full audit trail, verified by 145+ automated end-to-end checks, plus a browser demo with a policy sandbox and a live claim trace.

**AI engineering**
- Designed an LLM claims-triage pipeline where the model is advisory and deterministic rules decide
  routing; added a layered prompt-injection defence (independent detector, regex tripwire,
  schema-validated output, AI-vs-rules consistency check) and a held-out red-team harness that
  exposed detector overfitting (4/5 on the tuning set vs 1/8 on unseen attacks with a 3B local model),
  documented with the production remedy.

**Automation / integration**
- Built six n8n workflows (claims intake API, fraud-review sub-workflow with form-based approval and
  timeout escalation, claimant notifications, signed status API, scheduled ops report, global error
  handler) with idempotent intake, respond-before-routing, retries and dependency-ordered deployment
  from one-shot init/deploy containers, so Docker is the only prerequisite.

**Security and compliance**
- Implemented POPIA-minded data protection for a claims pipeline: field-level AES-256-GCM encryption
  with an HMAC blind index, TLS on every hop with certificate verification, no personal data sent to
  the LLM, masked error logging, HMAC-signed status links to prevent enumeration, and "no tipping
  off" rules so claimants never see fraud signals.

## Short blurb (GitHub / LinkedIn)

> ClaimFlow is an n8n portfolio project: an insurance claims pipeline where an LLM reads the
> claim, deterministic rules decide what happens, and a human reviews anything suspicious. It
> encrypts personal data, runs with nothing but Docker, and ships with 145+ automated checks, a browser sandbox,
> and an honest red-team report of where its AI defences fall short.

## Interview talking points

Each one is a real moment from the build: what I expected, what I measured, what I changed.

1. **"The native node measured 1 in 5."** I designed the injection detector around n8n's Guardrails
   node. Before trusting it, I probed it in a throwaway workflow against a local model: it caught
   1 of 5 attacks. The same prompt in a plain LLM Chain caught 3 of 5, so I switched, and wrote
   down why. *Lesson: verify the component, not the documentation.*

2. **"My detector was overfitted, and my own harness proved it."** The detector prompt scored
   4/5 on the attacks I tuned it on. A held-out set it had never seen (paraphrases, isiZulu,
   base64, fake JSON instructions) scored 1/8. I published both numbers, because the architecture
   (LLM has no authority, deterministic routing, bounded fast-track) is the real defence, and the
   detector needs a stronger model or a dedicated classifier.

3. **"The LLM scored attacks as zero risk, and the rules caught them anyway."** With a real local
   model, four of five injected claims got an AI risk score of 0. They still went to fraud review
   because the routing is deterministic. That's the strongest argument for AI + rules.

4. **"'Don't save execution data' doesn't mean nothing is saved."** I configured n8n not to keep
   data from successful runs of PII workflows, then checked the database: the raw webhook body was
   still written and only soft-deleted. I measured the purge (265 s), shortened the hard-delete
   cycle, and documented the real behaviour.

5. **"No tipping off."** In insurance, telling a claimant they're suspected of fraud is a
   compliance problem. Emails use neutral wording, and the public Status API maps
   "pending fraud review" to "under review", enforced by tests that scan every claimant email.

6. **"The tests caught my own bug."** A one-line SQL comment I added to the daily report swallowed a
   comma and broke the query. Only the end-to-end suite exercises that path, and it failed on its
   first run, before anything shipped.

## Likely questions, short answers

- **Why n8n and not code?** Visual, inspectable workflows that ops teams can follow, with built-in
  retries, credentials, webhooks, waits and forms. The complex logic lives in small, unit-tested
  Code nodes; everything is exported as JSON and deployed by script.
- **How would you scale it?** n8n queue mode with Redis and workers, external task runners,
  managed Postgres, and an outbox for email retries.
- **What would you change first for production?** A dedicated injection classifier proven on the
  red-team set, SSO on the review forms, keys in Key Vault, and email retries.
