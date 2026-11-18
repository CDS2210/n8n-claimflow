# Workflow 07: Demo Portal (demo mode only)

A way to **use** ClaimFlow in a browser: log a test claim through a form, then watch what the
pipeline did with it. It is published only when `CLAIMFLOW_DEMO_MODE=true` (re-run
`docker compose up -d` after changing it, which re-runs the deploy service). Workflow id `cfDemoPortal0001`.

```
 Claim_Form (n8n login)  →  Build_Claim_Func  →  Submit_Claim_HTTP  →  Read_Result_Func  →  Has_Claim_If
   /form/claim-demo          form → intake JSON   POST /webhook/claims   202/200/422: trace link   ├ Show_Trace_Form  (redirect)
                                                  (real intake API)      400: list the errors      └ Show_Errors_Form (message)

 Trace_Webhook  →  Validate_Trace_Func  →  Trace_Ok_If  →  Load_Trace_PG  →  Render_Trace_Func  →  Found_If  →  200 / 404
   GET /webhook/demo/trace?ref=&t=   demo on? signed?     claim + policy + events   HTML page
```

## Part 1: the claim form

- **n8n Form Trigger 2.6** with *n8n User Auth*: you must be logged in to n8n, so a stray tab or
  link can't submit claims.
- Fields: policy (dropdown of the seed policies with a hint of what each will show), name, email,
  phone, incident date, amount, description. The form header shows the current `LLM_MODE` and a
  few things to try.
- `Build_Claim_Func` builds the same JSON body an API client sends, with a fresh
  `demo-<uuid>` idempotency key and `channel: web`. **The form has no special path into the
  pipeline**: `Submit_Claim_HTTP` posts it to `POST /webhook/claims`, so validation, eligibility,
  encryption, the injection detector, the AI, the rules and routing are exactly what the API uses.
  It calls over the container's loopback and retries once, which is safe because the
  idempotency key makes a retry a duplicate, not a second claim.
- The answer decides the completion screen: any response with a `claim_ref` (202 accepted,
  200 duplicate, 422 ineligible) **redirects to the trace page**; a 400 shows the validation
  errors so you can go back and fix them.

## Part 2: the Claim Trace page

`GET /webhook/demo/trace?ref=CLM-…&t=…`, an **internal** view:

| Section | Shows |
|---|---|
| Header | status, route, final risk; "live" while anything is pending (refreshes every 3 s) |
| Pipeline steps | received → eligibility → injection check → AI analysis → rules → route → claimant emailed → human review, each done / warning / failed / waiting |
| The claim | policy, cover, amount, dates, and the description as escaped plain text |
| AI analysis | model and mode, AI risk score, type and severity, summary, fraud indicators, missing information, detector verdict and confidence |
| Rules, score and route | every rule flag with points and reason (hard flags highlighted), `0.6 × AI + 0.4 × rules`, the route and `route_reasons` |
| Human review | waiting (with a pointer to the Mailpit email) or the decision, reviewer and internal notes |
| Personal data protection | name and email **masked**, next to the stored ciphertext and blind-index prefix |
| Audit trail | every `claim_events` row with time, offset, actor and detail |
| Links | log another claim, Mailpit, the claimant's own Status API view (to compare), and n8n's Executions list |

Guards: the page returns 404 unless demo mode is on **and** `t = HMAC(CLAIMFLOW_STATUS_LINK_KEY,
"trace:" + ref)` matches (checked in constant time). The `trace:` prefix means a claimant's status
link (`status:`) can never open it. Personal details are decrypted only to be masked.

n8n serves webhook HTML under a sandbox Content-Security-Policy; the page needs no scripts (the
refresh is a `<meta>` tag), so it works with the sandbox left on.

## Part 3: watching it node by node

In demo mode the deploy service imports Intake, Fraud Review and Notifications with
`saveDataSuccessExecution: all` (the JSON files in `workflows/` keep `none`). Open
**Executions** in n8n and click a run to see each node's input and output, including the prompt
sent to the model and its raw answer. See [security.md](../security.md#demo-mode-claimflow_demo_modetrue-local-demos-only)
for why this is local-only.

## Tests

`run-scenarios.sh` checks demo mode in both states (F10, F11): trace page content, tampered and
cross-purpose tokens, the form's login redirect, and whether successful runs are kept. The form's
own flow (it needs a login) was verified with a temporary no-login copy; see
[testing.md](../testing.md).
