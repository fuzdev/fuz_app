/**
 * Audit log DDL — `CREATE TABLE` + index statements for the `audit_log` table.
 *
 * Consumed by `auth/migrations.ts`. Separated from `auth/audit_log_schema.ts`
 * so the schema module stays Zod-only (paired with `auth/auth_ddl.ts` and
 * `auth/role_grant_offer_ddl.ts`).
 *
 * Multi-actor invariants the envelope columns assume:
 *
 * - `actor_id` + `account_id`, when both populated, refer to the same
 *   account (derivable via `actor.account_id`). Denormalized for indexed
 *   audit queries; do not let them disagree.
 * - `target_actor_id` + `target_account_id`, same rule when both populated.
 * - `target_account_id` is the SSE/WS socket-close key — sessions stay
 *   account-grain after multi-actor lands, so this column carries the
 *   routing identity even on actor-bound events.
 * - `target_actor_id` is populated iff the event subject is actor-bound
 *   (see `AuditLogEvent.target_actor_id` doc-comment for the rule).
 *
 * @module
 */

export const AUDIT_LOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq SERIAL NOT NULL,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'success',
  actor_id UUID REFERENCES actor(id) ON DELETE SET NULL,
  account_id UUID REFERENCES account(id) ON DELETE SET NULL,
  target_account_id UUID REFERENCES account(id) ON DELETE SET NULL,
  target_actor_id UUID REFERENCES actor(id) ON DELETE SET NULL,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB
)`;

export const AUDIT_LOG_INDEXES = [
	`CREATE INDEX IF NOT EXISTS idx_audit_log_seq ON audit_log(seq DESC)`,
	`CREATE INDEX IF NOT EXISTS idx_audit_log_account ON audit_log(account_id)`,
	`CREATE INDEX IF NOT EXISTS idx_audit_log_event_type ON audit_log(event_type)`,
	`CREATE INDEX IF NOT EXISTS idx_audit_log_target_account ON audit_log(target_account_id)`,
	`CREATE INDEX IF NOT EXISTS idx_audit_log_target_actor ON audit_log(target_actor_id)`,
];
