-- =====================================================================
-- ClaimFlow application schema (database: claimflow)
-- Loaded automatically on first Postgres start by db/00-init-databases.sh
-- =====================================================================
-- Design notes
--   * Allowed values use CHECK constraints rather than ENUM types: easier to
--     extend later (ALTER TABLE ... DROP/ADD CONSTRAINT vs. ALTER TYPE).
--   * Money is numeric(12,2), never float. Currency defaults to ZAR.
--   * All timestamps are timestamptz (stored UTC, displayed in Africa/Johannesburg).
--   * claim_events is append-only: a trigger blocks UPDATE and DELETE.
--   * Personal information (name, email, phone) is stored ONLY as ciphertext produced by
--     n8n (AES-256-GCM, format v1:<iv>:<tag>:<data>). The DB never sees plaintext or keys.
--     Email also gets an HMAC-SHA256 blind index for exact-match lookups. docs/security.md
-- =====================================================================

SET client_min_messages = warning;

-- ---------------------------------------------------------------------
-- Shared helper: keep updated_at current on every UPDATE
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Format guards for encrypted personal information
CREATE DOMAIN pii_ciphertext AS text
  CHECK (VALUE ~ '^v[0-9]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$');
CREATE DOMAIN pii_blind_index AS text
  CHECK (VALUE ~ '^[0-9a-f]{64}$');

-- ---------------------------------------------------------------------
-- policies: who is covered, for what, and for how much
-- ---------------------------------------------------------------------
CREATE TABLE policies (
  policy_number  text PRIMARY KEY,
  -- PI, encrypted by n8n. Nullable only because seed rows are encrypted by the deploy service
  -- right after the schema loads (see db/seed.sql).
  holder_name_enc    pii_ciphertext,
  holder_email_enc   pii_ciphertext,
  holder_email_hmac  pii_blind_index,
  holder_phone_enc   pii_ciphertext,
  product        text           NOT NULL CHECK (product IN ('motor','home','travel','device')),
  sum_insured    numeric(12,2)  NOT NULL CHECK (sum_insured > 0),
  excess         numeric(12,2)  NOT NULL DEFAULT 0 CHECK (excess >= 0),
  currency       char(3)        NOT NULL DEFAULT 'ZAR',
  start_date     date           NOT NULL,
  end_date       date           NOT NULL,
  status         text           NOT NULL CHECK (status IN ('active','lapsed','cancelled')),
  created_at     timestamptz    NOT NULL DEFAULT now(),
  updated_at     timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT policies_cover_period_ck CHECK (end_date > start_date)
);

CREATE TRIGGER policies_set_updated_at
  BEFORE UPDATE ON policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- claims: one row per submitted claim, enriched as it moves through the pipeline
-- ---------------------------------------------------------------------
-- Human-friendly reference, e.g. CLM-2026-000123. The number comes from a
-- sequence (never reused); the year comes from reported_at.
CREATE SEQUENCE claim_ref_seq START 1;

CREATE TABLE claims (
  claim_ref               text PRIMARY KEY,               -- set by trigger below

  -- What the claimant sent. submitted_policy_number is kept even when no such
  -- policy exists, so invalid claims can still be stored and audited.
  submitted_policy_number text          NOT NULL,
  policy_number           text          REFERENCES policies (policy_number),  -- NULL if not found
  -- PI, encrypted by n8n (Encrypt_PII_Func). Seed rows are encrypted by the deploy service.
  claimant_name_enc       pii_ciphertext,
  claimant_email_enc      pii_ciphertext,
  claimant_email_hmac     pii_blind_index,
  claimant_phone_enc      pii_ciphertext,
  channel                 text          NOT NULL DEFAULT 'api'
                          CHECK (channel IN ('web','whatsapp','email','call_centre','api')),
  incident_date           date          NOT NULL,
  reported_at             timestamptz   NOT NULL DEFAULT now(),
  description             text          NOT NULL,
  claimed_amount          numeric(12,2) NOT NULL CHECK (claimed_amount > 0),
  currency                char(3)       NOT NULL DEFAULT 'ZAR',
  idempotency_key         text          NOT NULL UNIQUE,  -- duplicate submissions are detected here

  -- AI analysis (LLM output). ai_status records whether the analysis worked.
  ai_status               text          CHECK (ai_status IN ('ok','failed','skipped')),
  ai_model                text,
  ai_claim_type           text,
  ai_severity             text          CHECK (ai_severity IN ('low','medium','high','critical')),
  ai_summary              text,
  ai_fraud_indicators     jsonb         NOT NULL DEFAULT '[]'::jsonb,
  ai_missing_information  jsonb         NOT NULL DEFAULT '[]'::jsonb,
  ai_risk_score           smallint      CHECK (ai_risk_score BETWEEN 0 AND 100),

  -- Deterministic rules layer + blended score
  rule_flags              jsonb         NOT NULL DEFAULT '[]'::jsonb,
  rule_score              smallint      CHECK (rule_score BETWEEN 0 AND 100),
  final_risk_score        smallint      CHECK (final_risk_score BETWEEN 0 AND 100),

  -- Routing and lifecycle
  route                   text          CHECK (route IN ('fast_track','standard','fraud_review','manual_review','rejected')),
  status                  text          NOT NULL DEFAULT 'received' CHECK (status IN (
                            'received',                 -- stored, not yet routed
                            'rejected_ineligible',      -- failed policy eligibility
                            'in_standard_queue',        -- waiting for a claims handler
                            'pending_fraud_review',     -- waiting for the fraud team
                            'pending_manual_review',    -- AI failed; a human must triage
                            'approved_for_assessment',  -- cleared to be assessed/paid
                            'more_info_required',       -- claimant must send more detail
                            'rejected',                 -- rejected after review
                            'closed'                    -- finished (used by seed history)
                          )),
  rejection_reasons       jsonb         NOT NULL DEFAULT '[]'::jsonb,

  -- Human review
  reviewer                text,
  reviewer_notes          text,
  reviewed_at             timestamptz,

  raw_payload             jsonb         NOT NULL,         -- what arrived, with PI fields replaced by "[encrypted]"
  created_at              timestamptz   NOT NULL DEFAULT now(),
  updated_at              timestamptz   NOT NULL DEFAULT now()
);

-- Generate claim_ref before insert, e.g. CLM-2026-000123
CREATE OR REPLACE FUNCTION set_claim_ref() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.claim_ref IS NULL THEN
    NEW.claim_ref := 'CLM-'
      || to_char(COALESCE(NEW.reported_at, now()) AT TIME ZONE 'Africa/Johannesburg', 'YYYY')
      || '-' || lpad(nextval('claim_ref_seq')::text, 6, '0');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER claims_set_claim_ref
  BEFORE INSERT ON claims
  FOR EACH ROW EXECUTE FUNCTION set_claim_ref();

CREATE TRIGGER claims_set_updated_at
  BEFORE UPDATE ON claims
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Fraud rule "prior claims on this policy in the last 12 months"
CREATE INDEX claims_policy_reported_idx ON claims (policy_number, reported_at DESC);
-- Ops report + SLA checks
-- Blind-index lookups ("other claims from this email address")
CREATE INDEX claims_email_hmac_idx      ON claims (claimant_email_hmac);
CREATE INDEX claims_status_idx          ON claims (status, reported_at);
CREATE INDEX claims_created_idx         ON claims (created_at);

-- ---------------------------------------------------------------------
-- claim_events: append-only audit trail (who did what, when)
-- ---------------------------------------------------------------------
CREATE TABLE claim_events (
  id          bigserial   PRIMARY KEY,
  claim_ref   text        NOT NULL REFERENCES claims (claim_ref),
  event_type  text        NOT NULL,   -- e.g. received, ai_analysed, routed, review_decision
  actor       text        NOT NULL,   -- 'system', 'ai', or a reviewer's email
  detail      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX claim_events_claim_idx ON claim_events (claim_ref, created_at);

CREATE OR REPLACE FUNCTION block_audit_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'claim_events is append-only (% blocked)', TG_OP;
END $$;

CREATE TRIGGER claim_events_append_only
  BEFORE UPDATE OR DELETE ON claim_events
  FOR EACH ROW EXECUTE FUNCTION block_audit_changes();

-- ---------------------------------------------------------------------
-- workflow_errors: written by the Global Error Handler workflow
-- (PII such as emails/phones is masked by the workflow before insert)
-- ---------------------------------------------------------------------
CREATE TABLE workflow_errors (
  id            bigserial   PRIMARY KEY,
  workflow      text        NOT NULL,
  node          text,
  execution_id  text,
  message       text        NOT NULL,
  payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workflow_errors_created_idx ON workflow_errors (created_at DESC);

-- ---------------------------------------------------------------------
-- claim_status_public: the ONLY shape the public Status API reads.
-- Risk scores, fraud indicators and reviewer notes are deliberately absent,
-- so they cannot leak even if the API query is changed carelessly.
-- ---------------------------------------------------------------------
CREATE VIEW claim_status_public AS
SELECT
  c.claim_ref,
  c.status,
  c.incident_date,
  c.reported_at,
  c.updated_at,
  p.product,
  COALESCE(
    (SELECT jsonb_agg(jsonb_build_object('event', e.event_type, 'at', e.created_at)
                      ORDER BY e.created_at, e.id)
       FROM claim_events e
      WHERE e.claim_ref = c.claim_ref
        AND e.event_type IN ('received','routed','review_decision',
                             'notification_sent','rejected_ineligible','status_changed')),
    '[]'::jsonb) AS timeline
FROM claims c
LEFT JOIN policies p ON p.policy_number = c.policy_number;
