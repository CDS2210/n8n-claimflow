# Workflow 07: Demo Portal (demo mode only)

A way to **use** ClaimFlow in a browser: log a test claim through a form, then watch what the
pipeline did with it. It is published only when `CLAIMFLOW_DEMO_MODE=true` (re-run
`docker compose up -d` after changing it, which re-runs the deploy service). Workflow id `cfDemoPortal0001`.

```
 Claim_Form (page 1, n8n login) → Is_Sandbox_Choice_If ┬ Sandbox_Policy_Form (page 2) ┐
   /form/claim-demo: example or sandbox?               └ Example_Policy_Form (page 2) ┴→ Claim_Details_Form (page 3)

 → Build_Claim_Func → Build_Ok_If ┬ Has_Sandbox_If ┬ Create_Sandbox_PG → Use_Sandbox_Policy_Func ┐
   validate, encrypt holder       │                └────────────────────────────────────────────┴→ Submit_Claim_HTTP
                                  └ Show_Errors_Form (builder errors)                               POST /webhook/claims

 → Read_Result_Func → Has_Claim_If ┬ Show_Trace_Form  (202/200/422: redirect to the trace page)
                                   └ Show_Errors_Form (400: list the validation errors)

 Trace_Webhook  →  Validate_Trace_Func  →  Trace_Ok_If  →  Load_Trace_PG  →  Render_Trace_Func  →  Found_If  →  200 / 404
   GET /webhook/demo/trace?ref=&t=   demo on? signed?     claim + policy + events   HTML page
```

## Part 1: the claim form

- **n8n Form Trigger 2.6** with *n8n User Auth*: you must be logged in to n8n, so a stray tab or
  link can't submit claims.
- **Three pages.** Page 1 asks *example policy or build your own*, and shows the current
  `LLM_MODE`. Page 2 is either a dropdown of the seed policies (each with a hint of what it will
  show) or the **sandbox policy builder** below. Page 3 is the claim: name, email, phone, incident
  date, amount, description, with a few things to try.
- **Sandbox policy builder:** policy type, cover amount (sum insured), excess, start date, end
  date (default: start + 1 year), status (active / lapsed / cancelled) and the dates of earlier
  claims. `Build_Claim_Func` validates it (cover R1 000 to R10 000 000; excess below the cover;
  end after start; at most 10 earlier claims, none in the future or before the start) and lists
  every problem at once. `Create_Sandbox_PG` then stores, in one statement, a policy numbered
  `POL-SBX-000001`, `000002`, … (the holder is the claimant, encrypted like any PII) and the
  earlier claims as **closed** claims of R5 000 on those dates. The intake rules count them exactly
  like real history: 2 or more reported in the last 12 months fire `frequent_claimant`; older
  ones are stored but don't count. No schema change: the `POL-SBX-` prefix (and
  `raw_payload.sandbox` on the earlier claims) marks sandbox data, and a reset removes it.
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
| Policy and claim history | the policy (marked *sandbox* if built), cover, excess, period, status, and every earlier claim with **counted / too old, not counted** for the 12-month rule |
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
cross-purpose tokens, the form's login redirect, and whether successful runs are kept. **F12**
runs the workflow's own `Create_Sandbox_PG` statement (read from the JSON) and posts claims
through the API: a 10-day-old policy with 2 recent claims fires `new_policy` and
`frequent_claimant`; history older than 12 months doesn't count; a lapsed policy gets a 422; with
demo mode on, the trace page shows the history and what counted. The form pages themselves (they
need a login) were driven over HTTP with a temporary no-login copy; see [testing.md](../testing.md).
