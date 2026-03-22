/**
 * Version-gated database migration runner.
 *
 * Migrations are functions in ordered arrays, grouped by namespace.
 * A `schema_version` table tracks progress per namespace.
 * Each migration runs in its own transaction.
 *
 * **Forward-only**: No down-migrations. Schema changes are additive.
 * For pre-release development, collapse migrations into a single v0.
 *
 * **Named migrations**: Migrations can be bare functions or `{name, up}` objects.
 * Names appear in error messages for debuggability.
 *
 * **Advisory locking**: Per-namespace PostgreSQL advisory locks serialize
 * concurrent migration runs, preventing double-application in multi-instance deployments.
 *
 * @module
 */

import type {Db} from './db.js';

/**
 * A single migration function that receives a `Db` and applies DDL/DML.
 *
 * Runs inside a transaction — throw to rollback.
 */
export type MigrationFn = (db: Db) => Promise<void>;

/**
 * A migration: either a bare function or a named object with an `up` function.
 *
 * Named migrations include their name in error messages for debuggability.
 */
export type Migration = MigrationFn | {name: string; up: MigrationFn};

/**
 * A named group of ordered migrations.
 *
 * Array index = version number: `migrations[0]` is version 0, etc.
 */
export interface MigrationNamespace {
	namespace: string;
	migrations: Array<Migration>;
}

/** Result of running migrations for a single namespace. */
export interface MigrationResult {
	namespace: string;
	from_version: number;
	to_version: number;
	migrations_applied: number;
}

const SCHEMA_VERSION_DDL = `
CREATE TABLE IF NOT EXISTS schema_version (
  namespace TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

/** Normalize a migration to its function and optional name. */
const resolve_migration = (m: Migration): {fn: MigrationFn; name: string | null} => {
	if (typeof m === 'function') {
		return {fn: m, name: null};
	}
	return {fn: m.up, name: m.name};
};

/**
 * Compute a stable int32 advisory lock key from a namespace string.
 *
 * Uses djb2 hash, masked to int32 range for `pg_advisory_lock`.
 */
const namespace_lock_key = (namespace: string): number => {
	let hash = 5381;
	for (let i = 0; i < namespace.length; i++) {
		hash = ((hash << 5) + hash + namespace.charCodeAt(i)) | 0;
	}
	return hash;
};

/**
 * Run pending migrations for each namespace.
 *
 * Creates the `schema_version` tracking table if it does not exist,
 * then for each namespace: acquires an advisory lock, reads the current
 * version, runs pending migrations in order (each in its own transaction),
 * updates the stored version, and releases the lock.
 *
 * **Concurrency**: Uses PostgreSQL advisory locks to serialize concurrent
 * callers on the same namespace. Safe for multi-instance deployments.
 *
 * @param db - the database instance
 * @param namespaces - migration namespaces to process in order
 * @returns results per namespace (only includes namespaces that had work to do)
 */
export const run_migrations = async (
	db: Db,
	namespaces: Array<MigrationNamespace>,
): Promise<Array<MigrationResult>> => {
	await db.query(SCHEMA_VERSION_DDL);

	const results: Array<MigrationResult> = [];

	/* eslint-disable no-await-in-loop */
	for (const {namespace, migrations} of namespaces) {
		const lock_key = namespace_lock_key(namespace);

		// Acquire advisory lock — serializes concurrent migration runs
		try {
			await db.query('SELECT pg_advisory_lock($1)', [lock_key]);
		} catch {
			// Advisory lock not supported (e.g. some PGlite versions) — proceed without
		}

		try {
			const row = await db.query_one<{version: number}>(
				'SELECT version FROM schema_version WHERE namespace = $1',
				[namespace],
			);
			const current_version = row?.version ?? 0;

			if (current_version > migrations.length) {
				throw new Error(
					`schema_version for "${namespace}" is ${current_version} but only ${migrations.length} migrations exist — was a migration removed?`,
				);
			}

			if (current_version === migrations.length) {
				continue; // up to date
			}

			// run pending migrations, each in its own transaction with version upsert
			for (let i = current_version; i < migrations.length; i++) {
				const {fn, name} = resolve_migration(migrations[i]!);
				const label = name != null ? `"${name}"` : '';
				try {
					await db.transaction(async (tx) => {
						await fn(tx);
						await tx.query(
							`INSERT INTO schema_version (namespace, version, applied_at)
							 VALUES ($1, $2, NOW())
							 ON CONFLICT (namespace)
							 DO UPDATE SET version = $2, applied_at = NOW()`,
							[namespace, i + 1],
						);
					});
				} catch (err) {
					const name_part = label ? ` ${label}` : '';
					throw new Error(
						`Migration ${namespace}[${i}]${name_part} failed: ${err instanceof Error ? err.message : String(err)}`,
						{cause: err},
					);
				}
			}

			results.push({
				namespace,
				from_version: current_version,
				to_version: migrations.length,
				migrations_applied: migrations.length - current_version,
			});
		} finally {
			// Release advisory lock
			try {
				await db.query('SELECT pg_advisory_unlock($1)', [lock_key]);
			} catch {
				// Advisory lock not supported — nothing to release
			}
		}
	}
	/* eslint-enable no-await-in-loop */

	return results;
};
