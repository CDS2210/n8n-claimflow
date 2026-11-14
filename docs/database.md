# ClaimFlow database (`claimflow`)

Source of truth: [`db/schema.sql`](../db/schema.sql) · seed data: [`db/seed.sql`](../db/seed.sql)

## Entity relationship diagram

```mermaid
erDiagram
    policies ||--o{ claims : "covers (0..many)"
    claims   ||--|{ claim_events : "audit trail (1..many)"

    policies {
        text          policy_number PK "e.g. POL-MTR-100001"
        text          holder_name
        text          holder_email
        text          holder_phone
        text          product        "motor | home | travel | device"
        numeric       sum_insured    "max payout, ZAR"
        numeric       excess         "claimant pays first"
        char          currency       "ZAR"
        date          start_date
        date          end_date       "must be after start_date"
        text          status         "active | lapsed | cancelled"
        timestamptz   created_at
        timestamptz   updated_at
    }

    claims {
        text          claim_ref PK            "CLM-YYYY-NNNNNN (trigger)"
        text          submitted_policy_number "as sent, even if invalid"
        text          policy_number FK        "NULL if policy not found"
        text          claimant_name
        text          claimant_email
        text          claimant_phone
        text          channel                 "web | whatsapp | email | call_centre | api"
        date          incident_date
        timestamptz   reported_at
        text          description             "untrusted free text"
        numeric       claimed_amount          "> 0"
        char          currency
        text          idempotency_key UK      "duplicate guard"
        text          ai_status               "ok | failed | skipped"
        text          ai_model
        text          ai_claim_type
        text          ai_severity             "low | medium | high | critical"
        text          ai_summary
        jsonb         ai_fraud_indicators
        jsonb         ai_missing_information
        smallint      ai_risk_score           "0-100"
        jsonb         rule_flags
        smallint      rule_score              "0-100"
        smallint      final_risk_score        "0-100, blended"
        text          route                   "fast_track | standard | fraud_review | manual_review | rejected"
        text          status                  "lifecycle, see below"
        jsonb         rejection_reasons
        text          reviewer
        text          reviewer_notes
        timestamptz   reviewed_at
        jsonb         raw_payload             "exactly what arrived"
        timestamptz   created_at
        timestamptz   updated_at
    }

    claim_events {
        bigserial     id PK
        text          claim_ref FK
        text          event_type  "received | ai_analysed | routed | review_decision | ..."
        text          actor       "system | ai | reviewer email"
        jsonb         detail
        timestamptz   created_at
    }

    workflow_errors {
        bigserial     id PK
        text          workflow
        text          node
        text          execution_id
        text          message
        jsonb         payload     "PII masked before insert"
        timestamptz   created_at
    }
```

`workflow_errors` is intentionally standalone: an error may happen before a claim exists.

## How the tables are used by the workflows

| Table | Read by | Written by |
|---|---|---|
| `policies` | Intake (eligibility), Daily Report | seed only |
| `claims` | Intake (idempotency, prior claims), Fraud Review, Daily Report | Intake, Fraud Review |
| `claim_events` | Status API (via view), Daily Report | every workflow that changes a claim |
| `workflow_errors` | ops / debugging | Global Error Handler |
| `claim_status_public` (view) | Status API only | n/a, it's a view |

## Claim status lifecycle

```mermaid
stateDiagram-v2
    [*] --> received : POST /webhook/claims
    received --> rejected_ineligible : policy missing / not active /<br/>outside cover / amount > sum insured
    received --> approved_for_assessment : route = fast_track
    received --> in_standard_queue : route = standard
    received --> pending_fraud_review : route = fraud_review
    received --> pending_manual_review : AI failed (route = manual_review)
    pending_fraud_review --> approved_for_assessment : reviewer approves
    pending_fraud_review --> rejected : reviewer rejects
    pending_fraud_review --> more_info_required : reviewer asks for info
    in_standard_queue --> approved_for_assessment
    pending_manual_review --> approved_for_assessment
    approved_for_assessment --> closed
    rejected_ineligible --> [*]
    rejected --> [*]
    closed --> [*]
```

## Database-level safeguards

| Safeguard | How | Why |
|---|---|---|
| Unique claim references | `claim_ref_seq` + `claims_set_claim_ref` trigger | Only the DB hands out numbers, so no collisions under concurrency |
| No duplicate claims | `UNIQUE (idempotency_key)` | Last line of defence if two identical requests race |
| Tamper-proof audit trail | `claim_events_append_only` trigger blocks UPDATE/DELETE | History can't be rewritten |
| Valid values only | `CHECK` constraints (product, status, route, scores 0–100, amount > 0) | Bad data is rejected at the door |
| No score leakage | `claim_status_public` view has no risk/fraud/reviewer columns | Public API can't expose internals |
| Auto timestamps | `set_updated_at()` trigger | `updated_at` is always correct |
