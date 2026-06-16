/**
 * Auth schema migrations.
 *
 * Ordered list of `{name, up}` migrations for the fuz identity system tables.
 * Consumed by `run_migrations` with namespace `'fuz_auth'`.
 *
 * **The released chain is frozen — every schema change ships as an appended
 * migration.** Once a consumer holds a long-lived production database, an
 * already-bootstrapped DB has recorded the existing migrations as applied, so
 * editing a released migration's body in place is a silent no-op there: the
 * `CREATE TABLE IF NOT EXISTS` doesn't re-run, the runner sees nothing new,
 * and the new column never lands — a silent, total auth outage. (The
 * `deleted_at` / `deleted_by` soft-delete columns were added to v0's base DDL
 * this way; an older deployed DB never got them and every login broke.) So:
 * never edit, rename, reorder, or re-purpose an entry in `auth_migrations`
 * below. Add every additive change as a NEW appended entry using idempotent
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — a fresh bootstrap and an old
 * deployed DB then converge on the same shape:
 *
 * ```ts
 * // v2: add display_name to account
 * {
 *   name: 'account_display_name',
 *   up: async (db) => {
 *     await db.query('ALTER TABLE account ADD COLUMN IF NOT EXISTS display_name TEXT');
 *   },
 * },
 * ```
 *
 * The `/ready` schema-drift probe (`db/schema_ready.ts`) is the runtime net:
 * it fails the deploy loud when a live DB is missing a column the running code
 * expects, rather than letting auth break silently. Discipline prevents the
 * drift; the probe catches a lapse before cutover.
 *
 * Migrations are forward-only (no down). Use `IF NOT EXISTS` / `IF EXISTS`
 * for DDL safety. The `name` appears in error messages on failure. Dev/test
 * DBs (no long-lived data) may still drop + re-bootstrap freely on a break —
 * the freeze is the contract for the deployed chain, not local iteration.
 *
 * @module
 */

import {
	ACCOUNT_SCHEMA,
	ACCOUNT_EMAIL_INDEX,
	ACCOUNT_USERNAME_CI_INDEX,
	ACTOR_SCHEMA,
	ACTOR_INDEX,
	ACTOR_NAME_LOWER_INDEX,
	ROLE_GRANT_SCHEMA,
	ROLE_GRANT_INDEXES,
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
} from './auth_ddl.ts';
import {AUDIT_LOG_SCHEMA, AUDIT_LOG_INDEXES} from './audit_log_ddl.ts';
import {
	ROLE_GRANT_OFFER_SCHEMA,
	ROLE_GRANT_OFFER_PENDING_UNIQUE_INDEX,
	ROLE_GRANT_OFFER_INBOX_INDEX,
	ROLE_GRANT_OFFER_SCOPE_SENTINEL_UUID,
	ROLE_GRANT_OFFER_SCOPE_KIND_GLOBAL_TOKEN,
} from './role_grant_offer_ddl.ts';
import type {Db} from '../db/db.ts';
import type {Migration, MigrationNamespace} from '../db/migrate.ts';

/** Namespace identifier for fuz_app auth migrations. */
export const AUTH_MIGRATION_NAMESPACE = 'fuz_auth';

/**
 * Migration namespaces reserved by fuz_app. Consumers passing
 * `migration_namespaces` to `create_app_backend` must choose a name not in
 * this list — the runtime check rejects matches with a thrown error. Typed
 * as `ReadonlyArray<string>` (not a literal tuple) so `.includes()` accepts
 * any consumer-supplied namespace string without a cast.
 */
export const reserved_migration_namespaces: ReadonlyArray<string> = [AUTH_MIGRATION_NAMESPACE];

/**
 * Auth schema migrations in order.
 *
 * - v0: Full auth schema — account (with email_verified), actor, role_grant,
 *   auth_session, api_token, audit_log (with seq), bootstrap_lock, invite,
 *   app_settings, plus all indexes and seeds.
 * - v1: `role_grant_offer` table for consentful grants; adds `scope_id` /
 *   `scope_kind` / `source_offer_id` / `revoked_reason` to `role_grant` and
 *   swaps the `(actor_id, role)` partial unique index for a scope-aware
 *   variant using the index-side `'GLOBAL'` token + all-zeros sentinel
 *   UUID. The `(scope_kind, scope_id)` pair is enforced paired-null by
 *   `role_grant_scope_kind_paired` / `role_grant_offer_scope_kind_paired` CHECK
 *   constraints — both null for global, both non-null for scoped. The
 *   `role_grant_offer` table carries a `superseded_at` terminal state; its
 *   partial unique index is scoped by
 *   `(to_account, role, scope_kind, scope, from_actor)` so multiple
 *   grantors may coexist. `scope_kind` is informative-only in v1
 *   (registry-membership validation against `create_scope_kind_schema`);
 *   v2 may add INSERT-time `(role, scope_kind)` enforcement.
 */
export const auth_migrations: Array<Migration> = [
	// v0: full auth schema (frozen — never edit this body; see module doc)
	{
		name: 'full_auth_schema',
		up: async (db: Db): Promise<void> => {
			await db.query(ACCOUNT_SCHEMA);
			await db.query(ACCOUNT_EMAIL_INDEX);
			await db.query(ACCOUNT_USERNAME_CI_INDEX);
			await db.query(ACTOR_SCHEMA);
			await db.query(ACTOR_INDEX);
			await db.query(ACTOR_NAME_LOWER_INDEX);
			await db.query(ROLE_GRANT_SCHEMA);
			for (const sql of ROLE_GRANT_INDEXES) {
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
	// v1: consentful role_grants — role_grant_offer table + scoped role_grants
	{
		name: 'role_grant_offer_and_scoped_role_grants',
		up: async (db: Db): Promise<void> => {
			await db.query(ROLE_GRANT_OFFER_SCHEMA);
			await db.query(ROLE_GRANT_OFFER_PENDING_UNIQUE_INDEX);
			await db.query(ROLE_GRANT_OFFER_INBOX_INDEX);
			await db.query('ALTER TABLE role_grant ADD COLUMN IF NOT EXISTS scope_id UUID NULL');
			await db.query('ALTER TABLE role_grant ADD COLUMN IF NOT EXISTS scope_kind TEXT NULL');
			await db.query(
				'ALTER TABLE role_grant ADD COLUMN IF NOT EXISTS source_offer_id UUID NULL REFERENCES role_grant_offer(id) ON DELETE SET NULL',
			);
			await db.query('ALTER TABLE role_grant ADD COLUMN IF NOT EXISTS revoked_reason TEXT NULL');
			// Paired-null CHECK on `(scope_kind, scope_id)` — both null encodes
			// the global case; both non-null encodes a scoped grant. The DO
			// block makes constraint addition idempotent across migration
			// re-runs (Postgres has no `ADD CONSTRAINT IF NOT EXISTS` for
			// CHECK constraints — `pg_constraint` lookup is the established
			// shape).
			await db.query(`DO $$ BEGIN
				IF NOT EXISTS (
					SELECT 1 FROM pg_constraint WHERE conname = 'role_grant_scope_kind_paired'
				) THEN
					ALTER TABLE role_grant
						ADD CONSTRAINT role_grant_scope_kind_paired
						CHECK ((scope_kind IS NULL) = (scope_id IS NULL));
				END IF;
			END $$`);
			// Swap the (actor_id, role) partial unique for a scope-aware variant.
			// Existing rows have `scope_id = NULL` (and `scope_kind = NULL` per
			// the pair invariant) and collapse to the index-side `'GLOBAL'`
			// token + all-zeros sentinel UUID.
			await db.query('DROP INDEX IF EXISTS role_grant_actor_role_active_unique');
			await db.query('DROP INDEX IF EXISTS role_grant_actor_role_scope_active_unique');
			await db.query(
				`CREATE UNIQUE INDEX IF NOT EXISTS role_grant_actor_role_scope_active_unique
				   ON role_grant (
				     actor_id,
				     role,
				     COALESCE(scope_kind, '${ROLE_GRANT_OFFER_SCOPE_KIND_GLOBAL_TOKEN}'),
				     COALESCE(scope_id, '${ROLE_GRANT_OFFER_SCOPE_SENTINEL_UUID}'::uuid)
				   )
				   WHERE revoked_at IS NULL`,
			);
			await db.query(
				`CREATE INDEX IF NOT EXISTS role_grant_scope_active
				   ON role_grant (actor_id, role, scope_id)
				   WHERE revoked_at IS NULL`,
			);
		},
	},
];

/** Pre-composed migration namespace for auth tables. */
export const auth_migration_ns: MigrationNamespace = {
	namespace: AUTH_MIGRATION_NAMESPACE,
	migrations: auth_migrations,
};
