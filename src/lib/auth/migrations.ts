/**
 * Auth schema migrations.
 *
 * Ordered list of `{name, up}` migrations for the fuz identity system tables.
 * Consumed by `run_migrations` with namespace `'fuz_auth'`.
 *
 * **Schema is not stabilized yet — append-only is NOT the rule.** While
 * fuz_app is pre-stable, migration bodies, names, and positions can change
 * freely between versions; consumers upgrading across a schema change are
 * expected to drop and re-bootstrap their dev/test databases (production
 * deployments are not yet a supported use case). Once the schema is
 * declared stable a hard append-only-after-publish rule will apply and the
 * cliff will be called out in the release notes for that version. Until
 * then: edit, rename, reorder, or replace migrations as needed; bias toward
 * collapsing work into the existing v0/v1 entries rather than appending v2
 * patch migrations.
 *
 * To add a migration in the pre-stable phase, prefer extending an existing
 * entry's body (consumers will re-bootstrap on upgrade). If you do append
 * a new entry to `AUTH_MIGRATIONS`, the runner will apply it on existing
 * tracker rows — the same shape that will become mandatory once the
 * schema stabilizes:
 *
 * ```ts
 * // v2: add display_name to account
 * {
 *   name: 'account_display_name',
 *   up: async (db) => {
 *     await db.query('ALTER TABLE account ADD COLUMN display_name TEXT');
 *   },
 * },
 * ```
 *
 * Migrations are forward-only (no down). Use `IF NOT EXISTS` / `IF EXISTS`
 * for DDL safety. The `name` appears in error messages on failure.
 *
 * @module
 */

import {
	ACCOUNT_SCHEMA,
	ACCOUNT_EMAIL_INDEX,
	ACCOUNT_USERNAME_CI_INDEX,
	ACTOR_SCHEMA,
	ACTOR_INDEX,
	PERMIT_SCHEMA,
	PERMIT_INDEXES,
	AUTH_SESSION_SCHEMA,
	AUTH_SESSION_INDEXES,
	API_TOKEN_SCHEMA,
	API_TOKEN_INDEX,
	BOOTSTRAP_LOCK_SCHEMA,
	BOOTSTRAP_LOCK_SEED,
	INVITE_SCHEMA,
	INVITE_INDEXES,
	APP_SETTINGS_SCHEMA,
	APP_SETTINGS_SEED,
} from './ddl.js';
import {AUDIT_LOG_SCHEMA, AUDIT_LOG_INDEXES} from './audit_log_schema.js';
import {
	PERMIT_OFFER_SCHEMA,
	PERMIT_OFFER_PENDING_UNIQUE_INDEX,
	PERMIT_OFFER_INBOX_INDEX,
	PERMIT_OFFER_SCOPE_SENTINEL_UUID,
	PERMIT_OFFER_SCOPE_KIND_GLOBAL_TOKEN,
} from './permit_offer_schema.js';
import type {Db} from '../db/db.js';
import type {Migration, MigrationNamespace} from '../db/migrate.js';

/** Namespace identifier for fuz_app auth migrations. */
export const AUTH_MIGRATION_NAMESPACE = 'fuz_auth';

/**
 * Auth schema migrations in order.
 *
 * - v0: Full auth schema — account (with email_verified), actor, permit,
 *   auth_session, api_token, audit_log (with seq), bootstrap_lock, invite,
 *   app_settings, plus all indexes and seeds.
 * - v1: `permit_offer` table for consentful grants; adds `scope_id` /
 *   `scope_kind` / `source_offer_id` / `revoked_reason` to `permit` and
 *   swaps the `(actor_id, role)` partial unique index for a scope-aware
 *   variant using the index-side `'GLOBAL'` token + all-zeros sentinel
 *   UUID. The `(scope_kind, scope_id)` pair is enforced paired-null by
 *   `permit_scope_kind_paired` / `permit_offer_scope_kind_paired` CHECK
 *   constraints — both null for global, both non-null for scoped. The
 *   `permit_offer` table carries a `superseded_at` terminal state; its
 *   partial unique index is scoped by
 *   `(to_account, role, scope_kind, scope, from_actor)` so multiple
 *   grantors may coexist. `scope_kind` is informative-only in v1
 *   (registry-membership validation against `create_scope_kind_schema`);
 *   v2 may add INSERT-time `(role, scope_kind)` enforcement.
 */
export const AUTH_MIGRATIONS: Array<Migration> = [
	// v0: full auth schema — all IF NOT EXISTS, safe for existing databases
	{
		name: 'full_auth_schema',
		up: async (db: Db): Promise<void> => {
			await db.query(ACCOUNT_SCHEMA);
			await db.query(ACCOUNT_EMAIL_INDEX);
			await db.query(ACCOUNT_USERNAME_CI_INDEX);
			await db.query(ACTOR_SCHEMA);
			await db.query(ACTOR_INDEX);
			await db.query(PERMIT_SCHEMA);
			for (const sql of PERMIT_INDEXES) {
				await db.query(sql);
			}
			await db.query(AUTH_SESSION_SCHEMA);
			for (const sql of AUTH_SESSION_INDEXES) {
				await db.query(sql);
			}
			await db.query(API_TOKEN_SCHEMA);
			await db.query(API_TOKEN_INDEX);
			await db.query(AUDIT_LOG_SCHEMA);
			for (const sql of AUDIT_LOG_INDEXES) {
				await db.query(sql);
			}
			await db.query(BOOTSTRAP_LOCK_SCHEMA);
			await db.query(BOOTSTRAP_LOCK_SEED);
			await db.query(INVITE_SCHEMA);
			for (const sql of INVITE_INDEXES) {
				await db.query(sql);
			}
			await db.query(APP_SETTINGS_SCHEMA);
			await db.query(APP_SETTINGS_SEED);
		},
	},
	// v1: consentful permits — permit_offer table + scoped permits
	{
		name: 'permit_offer_and_scoped_permits',
		up: async (db: Db): Promise<void> => {
			await db.query(PERMIT_OFFER_SCHEMA);
			await db.query(PERMIT_OFFER_PENDING_UNIQUE_INDEX);
			await db.query(PERMIT_OFFER_INBOX_INDEX);
			await db.query('ALTER TABLE permit ADD COLUMN IF NOT EXISTS scope_id UUID NULL');
			await db.query('ALTER TABLE permit ADD COLUMN IF NOT EXISTS scope_kind TEXT NULL');
			await db.query(
				'ALTER TABLE permit ADD COLUMN IF NOT EXISTS source_offer_id UUID NULL REFERENCES permit_offer(id) ON DELETE SET NULL',
			);
			await db.query('ALTER TABLE permit ADD COLUMN IF NOT EXISTS revoked_reason TEXT NULL');
			// Paired-null CHECK on `(scope_kind, scope_id)` — both null encodes
			// the global case; both non-null encodes a scoped grant. The DO
			// block makes constraint addition idempotent across migration
			// re-runs (Postgres has no `ADD CONSTRAINT IF NOT EXISTS` for
			// CHECK constraints — `pg_constraint` lookup is the established
			// shape).
			await db.query(`DO $$ BEGIN
				IF NOT EXISTS (
					SELECT 1 FROM pg_constraint WHERE conname = 'permit_scope_kind_paired'
				) THEN
					ALTER TABLE permit
						ADD CONSTRAINT permit_scope_kind_paired
						CHECK ((scope_kind IS NULL) = (scope_id IS NULL));
				END IF;
			END $$`);
			// Swap the (actor_id, role) partial unique for a scope-aware variant.
			// Existing rows have `scope_id = NULL` (and `scope_kind = NULL` per
			// the pair invariant) and collapse to the index-side `'GLOBAL'`
			// token + all-zeros sentinel UUID.
			await db.query('DROP INDEX IF EXISTS permit_actor_role_active_unique');
			await db.query('DROP INDEX IF EXISTS permit_actor_role_scope_active_unique');
			await db.query(
				`CREATE UNIQUE INDEX IF NOT EXISTS permit_actor_role_scope_active_unique
				   ON permit (
				     actor_id,
				     role,
				     COALESCE(scope_kind, '${PERMIT_OFFER_SCOPE_KIND_GLOBAL_TOKEN}'),
				     COALESCE(scope_id, '${PERMIT_OFFER_SCOPE_SENTINEL_UUID}'::uuid)
				   )
				   WHERE revoked_at IS NULL`,
			);
			await db.query(
				`CREATE INDEX IF NOT EXISTS permit_scope_active
				   ON permit (actor_id, role, scope_id)
				   WHERE revoked_at IS NULL`,
			);
		},
	},
];

/** Pre-composed migration namespace for auth tables. */
export const AUTH_MIGRATION_NS: MigrationNamespace = {
	namespace: AUTH_MIGRATION_NAMESPACE,
	migrations: AUTH_MIGRATIONS,
};
