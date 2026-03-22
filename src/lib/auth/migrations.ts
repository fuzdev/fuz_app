/**
 * Auth schema migrations.
 *
 * Single v0 migration for the fuz identity system tables.
 * Consumed by `run_migrations` with namespace `'fuz_auth'`.
 *
 * Collapsed to a single v0 for the 0.1.0 release — no production databases
 * exist, so the prior v0–v6 development iterations are consolidated.
 * Post-0.1.0, each new migration appends as v1, v2, etc.
 *
 * To add a migration, append a new entry to `AUTH_MIGRATIONS`:
 *
 * ```ts
 * // v1: add display_name to account
 * {
 *   name: 'account_display_name',
 *   up: async (db) => {
 *     await db.query('ALTER TABLE account ADD COLUMN display_name TEXT');
 *   },
 * },
 * ```
 *
 * Migrations are forward-only (no down). Use `IF NOT EXISTS` / `IF EXISTS`
 * for DDL safety. Named migrations (`{name, up}`) are preferred for
 * debuggability — the name appears in error messages on failure.
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
				await db.query(sql); // eslint-disable-line no-await-in-loop
			}
			await db.query(AUTH_SESSION_SCHEMA);
			for (const sql of AUTH_SESSION_INDEXES) {
				await db.query(sql); // eslint-disable-line no-await-in-loop
			}
			await db.query(API_TOKEN_SCHEMA);
			await db.query(API_TOKEN_INDEX);
			await db.query(AUDIT_LOG_SCHEMA);
			for (const sql of AUDIT_LOG_INDEXES) {
				await db.query(sql); // eslint-disable-line no-await-in-loop
			}
			await db.query(BOOTSTRAP_LOCK_SCHEMA);
			await db.query(BOOTSTRAP_LOCK_SEED);
			await db.query(INVITE_SCHEMA);
			for (const sql of INVITE_INDEXES) {
				await db.query(sql); // eslint-disable-line no-await-in-loop
			}
			await db.query(APP_SETTINGS_SCHEMA);
			await db.query(APP_SETTINGS_SEED);
		},
	},
];

/** Pre-composed migration namespace for auth tables. */
export const AUTH_MIGRATION_NS: MigrationNamespace = {
	namespace: AUTH_MIGRATION_NAMESPACE,
	migrations: AUTH_MIGRATIONS,
};
