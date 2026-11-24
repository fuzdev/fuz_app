/**
 * Identity-tracked database migration runner.
 *
 * Migrations are named `{name, up}` objects in ordered arrays, grouped by
 * namespace. A `schema_version` table records one row per applied migration —
 * `(namespace, name, sequence, applied_at)` — and the runner verifies the
 * applied list is a name-prefix of the code's migration array at boot.
 *
 * **`name` is descriptive identity, not a version ordinal.** The runner orders
 * by the `sequence` column and matches `name` by array position — it never
 * parses the name — so `name` carries *what the migration is*
 * (`full_cell_schema`, `role_grant_offer_and_scoped_role_grants`), and the
 * redundant `_vN` ordinal is avoided (it would only duplicate `sequence`, and
 * a `cell_v0` name tempts editing "v0" in place). `name` is half the
 * `schema_version` PK (with `namespace`), so a rename is an identity change
 * every already-migrated DB sees as `name-divergence-at-N`. This is also the
 * cross-impl contract: the TS and Rust spines must record byte-identical
 * `(namespace, name, sequence)` so a consumer can swap backends over one DB.
 *
 * **Schema is not stabilized yet — append-only is NOT the rule.** While
 * fuz_app is pre-stable, migration bodies, names, and positions can change
 * freely between versions; consumers upgrading across a schema change are
 * expected to drop and re-bootstrap their dev/test databases (production
 * deployments are not yet a supported use case). Once the schema is
 * declared stable a hard append-only-after-publish rule will apply and the
 * cliff will be called out in that release's notes; until then, body edits
 * to a published migration slip past the runner (no content hashing) by
 * design — they're the recommended way to evolve the schema.
 *
 * **Chain-level transactions**: All pending migrations in a namespace run in
 * a single transaction. Any failure rolls back every migration in that run —
 * no partial-state recovery. This rules out non-transactional DDL (e.g.,
 * `CREATE INDEX CONCURRENTLY`); run those out of band.
 *
 * **Chain idempotency, not migration idempotency**: the chain-tx wraps every
 * migration replayed in a single boot, so an individual migration may
 * temporarily produce intermediate state that a later migration reverses
 * (e.g. v0's `ROLE_GRANT_INDEXES` recreates an index that v1 drops; chain-tx
 * hides this from observers). What matters is that the *committed end state*
 * matches; the in-tx steps may not be individually idempotent against an
 * arbitrary mid-chain target.
 *
 * **Forward-only**: No down-migrations. Schema changes are additive.
 *
 * **Advisory locking**: each namespace's chain transaction opens with
 * `pg_advisory_xact_lock` on the namespace's key, so concurrent boots over
 * one database take turns: the second waits for the first's commit, then
 * reads its migrations applied. The lock is transaction-scoped because a
 * pool hands each `Db.query` whichever client is free — a session lock and
 * its unlock could land on different clients, leaving the lock held on an
 * idle one. Inside the transaction there is nothing to unlock and so nothing
 * to leak: the commit or rollback releases it. The Rust spine takes a
 * session `pg_advisory_lock` on the same `bigint` key, and the two forms
 * conflict, so a TS and a Rust boot take turns too. Without the lock the
 * `(namespace, name)` PK keeps a migration from recording twice, but two
 * chains running at once collide on their own DDL and the loser's boot
 * fails. The read after the lock sees the winner's commit only at READ
 * COMMITTED, the default: under REPEATABLE READ the transaction's snapshot
 * predates the lock's wait, so `create_app_backend` refuses a database at any
 * other default before it migrates (`ensure_read_committed`). pglet and
 * PGlite take the lock as Postgres does.
 *
 * @module
 */

import { to_error_message } from '@fuzdev/fuz_util/error.ts';
import type { Logger } from '@fuzdev/fuz_util/log.ts';

import type { Db } from './db.ts';
import { pg_error_code } from './pg_error.ts';

/**
 * A single migration: a name + an `up` function applied inside a transaction.
 *
 * Throw from `up` to roll back the entire chain.
 */
export interface Migration {
	name: string;
	up: (db: Db) => Promise<void>;
}

/**
 * A named group of ordered migrations.
 *
 * A consumer builds one as a plain literal under a name of its own; the spine's
 * namespaces (`reserved_migration_namespaces`) come from
 * `create_spine_migration_namespace`. Array index = position in the chain. Pre-stable: bodies, names, and
 * positions can change between versions (consumers re-bootstrap on upgrade).
 */
export interface MigrationNamespace {
	namespace: string;
	migrations: Array<Migration>;
}

/** Result of running migrations for a single namespace. */
export interface MigrationResult {
	namespace: string;
	/** Migrations applied in this run, in sequence-ascending (execution) order. */
	applied_names: Array<string>;
}

/**
 * Tagged error vocabulary for `run_migrations` and `baseline`.
 *
 * Callers branch on `.kind` rather than matching error messages — message
 * text is for operators, not control flow.
 */
export type MigrationErrorKind =
	| 'namespace-reserved'
	| 'binary-older-than-db'
	| 'name-divergence-at-N'
	| 'migration-failed'
	| 'migration-lock-failed'
	| 'baseline-name-not-in-code'
	| 'baseline-name-out-of-order'
	| 'baseline-namespace-already-populated';

/** Structured context passed alongside a `MigrationError`. */
export interface MigrationErrorContext {
	namespace?: string;
	at_index?: number;
	unknown_names?: ReadonlyArray<string>;
	cause?: unknown;
}

/**
 * Tagged error thrown by `run_migrations` and `baseline`.
 *
 * Branch on `.kind`; the message carries an operator-facing remediation hint.
 */
export class MigrationError extends Error {
	readonly kind: MigrationErrorKind;
	readonly namespace?: string;
	readonly at_index?: number;
	readonly unknown_names?: ReadonlyArray<string>;

	constructor(kind: MigrationErrorKind, message: string, context?: MigrationErrorContext) {
		super(message, context?.cause !== undefined ? { cause: context.cause } : undefined);
		this.name = 'MigrationError';
		this.kind = kind;
		this.namespace = context?.namespace;
		this.at_index = context?.at_index;
		this.unknown_names = context?.unknown_names;
	}
}

/**
 * Migration namespace names reserved by the spine: auth (`fuz_auth`), cells
 * (`fuz_cell`), and facts (`fuz_facts`) — the Rust spine's
 * `RESERVED_NAMESPACES`. Only a namespace built by
 * `create_spine_migration_namespace` runs under one: `run_migrations` and
 * `baseline` refuse any other `MigrationNamespace` bearing one of these names,
 * so a consumer can't mint tracker rows that collide with a spine chain's.
 * Typed as `ReadonlyArray<string>` (not a literal tuple) so `.includes()`
 * accepts any namespace string without a cast.
 */
export const reserved_migration_namespaces: ReadonlyArray<string> = [
	'fuz_auth',
	'fuz_cell',
	'fuz_facts'
];

/** The namespace objects the spine built, the only ones admitted under a reserved name. */
const spine_migration_namespaces: WeakSet<MigrationNamespace> = new WeakSet();

/**
 * Build a spine module's own migration namespace (auth, cells, facts) — the
 * one form `run_migrations` and `baseline` admit under a
 * `reserved_migration_namespaces` name. Admission is by object identity, so
 * consumers splice the exported object itself (`CELL_MIGRATION_NS`), never a
 * copy; consumer code builds a plain `MigrationNamespace` literal instead.
 *
 * @param namespace - one of `reserved_migration_namespaces`
 * @param migrations - the chain, in execution order
 * @returns the namespace, registered as the spine's
 * @throws Error when `namespace` is not a reserved name
 */
export const create_spine_migration_namespace = (
	namespace: string,
	migrations: Array<Migration>
): MigrationNamespace => {
	if (!reserved_migration_namespaces.includes(namespace)) {
		throw new Error(
			`migration namespace "${namespace}" is built as a spine namespace but is not a reserved spine name; build a plain MigrationNamespace instead`
		);
	}
	const ns: MigrationNamespace = { namespace, migrations };
	spine_migration_namespaces.add(ns);
	return ns;
};

/**
 * Refuse a namespace bearing a `reserved_migration_namespaces` name unless the
 * spine built it (`create_spine_migration_namespace`). `run_migrations` and
 * `baseline` run this before touching the database; a server assembly can
 * call it to refuse a bad chain earlier.
 *
 * @param namespaces - the chain to check
 * @throws MigrationError with `kind` `namespace-reserved`, naming the first offending namespace
 */
export const assert_migration_namespaces = (
	namespaces: ReadonlyArray<MigrationNamespace>
): void => {
	for (const ns of namespaces) {
		if (
			reserved_migration_namespaces.includes(ns.namespace) &&
			!spine_migration_namespaces.has(ns)
		) {
			throw new MigrationError(
				'namespace-reserved',
				`migration namespace "${ns.namespace}" is reserved for the spine; a consumer namespace must choose a different name. ` +
					`Hint: to run the spine's own chain, pass its exported namespace object, not a copy.`,
				{ namespace: ns.namespace }
			);
		}
	}
};

const SCHEMA_VERSION_DDL = `
CREATE TABLE IF NOT EXISTS schema_version (
  namespace  TEXT        NOT NULL,
  name       TEXT        NOT NULL,
  sequence   INTEGER     NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (namespace, name),
  UNIQUE (namespace, sequence)
)`;

/**
 * The `schema_version` DDL's outcomes when a concurrent boot created the table
 * first: `CREATE TABLE IF NOT EXISTS` checks for the table before taking any
 * lock, so two boots can both pass the check, and the loser then trips the
 * catalog's unique index (`23505`) or finds the relation (`42P07`) or a
 * constraint (`42710`) already there. The Rust runner tolerates the same codes.
 */
const SCHEMA_VERSION_DDL_RACE_CODES: ReadonlyArray<string> = ['23505', '42P07', '42710'];

/**
 * Apply the `schema_version` DDL, tolerating the race with a concurrent boot
 * that created the table first (`SCHEMA_VERSION_DDL_RACE_CODES`). It runs
 * before any namespace's lock, so concurrent boots run it at once.
 */
const ensure_schema_version_table = async (db: Db, log: Logger | undefined): Promise<void> => {
	try {
		await db.query(SCHEMA_VERSION_DDL);
	} catch (err) {
		const code = pg_error_code(err);
		if (code === null || !SCHEMA_VERSION_DDL_RACE_CODES.includes(code)) throw err;
		log?.debug(`schema_version DDL raced (${code}); another boot won`);
	}
};

/**
 * Compute a stable advisory lock key from a namespace string — djb2 over the
 * name's UTF-8 bytes, in int32 arithmetic.
 *
 * The Rust twin hashes the same bytes and widens the int32 to the `bigint`
 * `pg_advisory_lock(bigint)` takes; this number reaches Postgres as that same
 * `bigint`, so one namespace locks one key on both spines.
 *
 * @param namespace - the migration namespace's name
 * @returns the int32 key
 */
export const namespace_lock_key = (namespace: string): number => {
	let hash = 5381;
	for (const byte of new TextEncoder().encode(namespace)) {
		hash = ((hash << 5) + hash + byte) | 0;
	}
	return hash;
};

/**
 * Take the namespace's advisory lock in the open transaction `tx` — held
 * until it commits or rolls back (module doc, "Advisory locking"). A failed
 * lock fails the run naming the namespace, the driver error as its `cause`
 * (a cancel, a `statement_timeout` or a `lock_timeout` keeps its SQLSTATE
 * there). Twin of the Rust `MigrationError::LockFailed`.
 *
 * @throws MigrationError with `kind` `migration-lock-failed`
 */
const lock_namespace = async (tx: Db, namespace: string): Promise<void> => {
	try {
		await tx.query('SELECT pg_advisory_xact_lock($1)', [namespace_lock_key(namespace)]);
	} catch (err) {
		throw new MigrationError(
			'migration-lock-failed',
			`Namespace "${namespace}" could not take its advisory lock: ${to_error_message(err)}. ` +
				`Hint: nothing in this namespace was applied; check the connection and any ` +
				`\`lock_timeout\` or \`statement_timeout\` set for the role or database, then retry.`,
			{ namespace, cause: err }
		);
	}
};

/** Options for `run_migrations`. */
export interface RunMigrationsOptions {
	/** Receives the debug line for a tolerated `schema_version` DDL race. */
	log?: Logger;
}

/**
 * Run pending migrations for each namespace.
 *
 * For each namespace, in one chain transaction: takes the namespace's
 * advisory lock, reads applied rows ordered by `sequence`, length-checks
 * (binary-older-than-db short-circuits), name-prefix-verifies, then runs the
 * pending tail. Each migration's row is INSERTed with
 * `sequence = max(sequence) + 1` for the namespace.
 *
 * **Length check before name verify** is load-bearing: a binary-older case
 * with a rename in the overlap would otherwise fire `name-divergence-at-N`
 * first and the operator would chase a phantom source-revert before
 * discovering the binary is the real problem.
 *
 * **Atomicity**: any failure rolls back every migration that ran in that
 * invocation. Namespaces are independent: a later namespace's failure does
 * not roll back an earlier namespace that already committed.
 *
 * **Concurrency**: the per-namespace advisory lock serializes concurrent
 * boots, TS or Rust, over one database (module doc, "Advisory locking").
 * The `schema_version` DDL runs before it, and its race with another boot
 * is tolerated.
 *
 * @param db - the database instance
 * @param namespaces - migration namespaces, processed in the order passed
 * @param options - `log` for the tolerated DDL race
 * @returns one result per namespace where work happened (already-up-to-date
 *   namespaces are omitted)
 * @mutates schema_version - inserts one row per applied migration
 * @throws MigrationError with `kind` of `namespace-reserved` (before touching
 *   the database), `migration-lock-failed`, `binary-older-than-db`,
 *   `name-divergence-at-N`, or `migration-failed`
 */
export const run_migrations = async (
	db: Db,
	namespaces: Array<MigrationNamespace>,
	options?: RunMigrationsOptions
): Promise<Array<MigrationResult>> => {
	assert_migration_namespaces(namespaces);
	await ensure_schema_version_table(db, options?.log);

	const results: Array<MigrationResult> = [];

	for (const { namespace, migrations } of namespaces) {
		const applied_names = await db.transaction(async (tx) => {
			await lock_namespace(tx, namespace);
			const applied = await tx.query<{ name: string; sequence: number }>(
				`SELECT name, sequence FROM schema_version
				 WHERE namespace = $1
				 ORDER BY sequence ASC`,
				[namespace]
			);

			// Step 3: length check (short-circuits before name verify)
			if (applied.length > migrations.length) {
				const unknown_names = applied.slice(migrations.length).map((r) => r.name);
				throw new MigrationError(
					'binary-older-than-db',
					`Namespace "${namespace}": database has ${applied.length} applied migrations ` +
						`but the code only knows ${migrations.length}. ` +
						`Unknown to this binary: ${unknown_names.map((n) => `"${n}"`).join(', ')}. ` +
						`Hint: upgrade the code to a version that includes these migrations; ` +
						`if you must downgrade, manually delete the unknown rows from schema_version.`,
					{ namespace, unknown_names }
				);
			}

			// Step 4: name-prefix verify
			for (let i = 0; i < applied.length; i++) {
				const applied_name = applied[i]!.name;
				const code_name = migrations[i]!.name;
				if (applied_name !== code_name) {
					throw new MigrationError(
						'name-divergence-at-N',
						`Namespace "${namespace}": applied[${i}].name = "${applied_name}" ` +
							`but code[${i}].name = "${code_name}". ` +
							`Hint: the migrations array was reordered or renamed (revert the source ` +
							`change), OR row ${i} or earlier was deleted from the tracker ` +
							`(re-insert the missing row with a sequence value lower than the rows ` +
							`that follow it, or delete from row ${i} onward to re-apply the tail).`,
						{ namespace, at_index: i }
					);
				}
			}

			// up-to-date case
			if (applied.length === migrations.length) return null;

			// Step 5: run the pending tail in this chain-tx
			let next_sequence = applied.length > 0 ? applied[applied.length - 1]!.sequence + 1 : 0;
			const names: Array<string> = [];
			for (let i = applied.length; i < migrations.length; i++) {
				const m = migrations[i]!;
				try {
					await m.up(tx);
					await tx.query(
						`INSERT INTO schema_version (namespace, name, sequence)
						 VALUES ($1, $2, $3)`,
						[namespace, m.name, next_sequence]
					);
					names.push(m.name);
					next_sequence++;
				} catch (err) {
					if (err instanceof MigrationError) throw err;
					throw new MigrationError(
						'migration-failed',
						`Migration ${namespace}["${m.name}"] failed: ` +
							`${to_error_message(err)}. ` +
							`Hint: fix the migration body and retry; the chain is left at the prior committed version.`,
						{ namespace, at_index: i, cause: err }
					);
				}
			}
			return names;
		});
		if (applied_names !== null) results.push({ namespace, applied_names });
	}

	return results;
};

/** Options for `baseline`. */
export interface BaselineOptions {
	/** Receives the debug line for a tolerated `schema_version` DDL race. */
	log?: Logger;
}

/**
 * Insert tracker rows for the named migrations of a namespace **without
 * executing them**.
 *
 * Used to promote an existing schema (e.g. produced by an out-of-band
 * bootstrap, or a hand-applied DDL set) into the identity tracker.
 * `baseline()` trusts the operator-supplied list — it does not verify that
 * the schema actually matches what the named migrations would have produced.
 * Pair with a schema-assertion script post-baseline before re-enabling traffic.
 *
 * Contract:
 * - Creates the `schema_version` table if missing — a promotion script can
 *   call `baseline()` against a fresh tracker with no separate DDL step.
 * - Takes the same per-namespace advisory lock as `run_migrations`, in the
 *   transaction that writes the rows.
 * - Refuses if any tracker rows already exist *for this namespace* — lets
 *   multi-call baseline scripts resume after partial failure (completed
 *   namespaces guard themselves while remaining ones still run).
 * - Verifies the supplied names are a strict prefix of the namespace's
 *   current migrations array — a name not in the array, or out of order,
 *   errors before any INSERT.
 * - Writes sequences `0..N-1` in that transaction.
 *
 * @param db - the database instance
 * @param ns - the namespace whose migrations are being baselined
 * @param names - prefix of `ns.migrations[].name` to record as already-applied
 * @param options - `log` for the tolerated DDL race
 * @mutates schema_version - inserts tracker rows for `names` without running
 *   the corresponding migration bodies
 * @throws MigrationError with `kind` of `namespace-reserved` (before touching
 *   the database), `baseline-name-not-in-code`, `baseline-name-out-of-order`,
 *   `migration-lock-failed`, or `baseline-namespace-already-populated`
 */
export const baseline = async (
	db: Db,
	ns: MigrationNamespace,
	names: ReadonlyArray<string>,
	options?: BaselineOptions
): Promise<void> => {
	assert_migration_namespaces([ns]);
	await ensure_schema_version_table(db, options?.log);

	const code_names = ns.migrations.map((m) => m.name);

	// Validate every supplied name exists in code (catches drift between cutover
	// script and deployed build before any INSERT).
	for (const name of names) {
		if (!code_names.includes(name)) {
			throw new MigrationError(
				'baseline-name-not-in-code',
				`baseline: name "${name}" is not in namespace "${ns.namespace}" migrations. ` +
					`Hint: confirm the deployed fuz_app version matches what the cutover script ` +
					`was written against — name drift between build and script is the most common cause.`,
				{ namespace: ns.namespace }
			);
		}
	}

	// Validate names are a strict prefix of code_names (catches reordering).
	for (let i = 0; i < names.length; i++) {
		if (names[i] !== code_names[i]) {
			throw new MigrationError(
				'baseline-name-out-of-order',
				`baseline: namespace "${ns.namespace}" supplied names are not a prefix of ` +
					`the code's migrations. At position ${i}: supplied "${names[i]}" but code ` +
					`expects "${code_names[i]}". Hint: re-order the supplied names to match ` +
					`the code's array order.`,
				{ namespace: ns.namespace, at_index: i }
			);
		}
	}

	await db.transaction(async (tx) => {
		await lock_namespace(tx, ns.namespace);
		const existing = await tx.query<{ name: string }>(
			'SELECT name FROM schema_version WHERE namespace = $1 LIMIT 1',
			[ns.namespace]
		);
		if (existing.length > 0) {
			throw new MigrationError(
				'baseline-namespace-already-populated',
				`baseline: namespace "${ns.namespace}" already has tracker rows. ` +
					`Hint: per-namespace guard for partial-failure resume — completed namespaces ` +
					`self-skip; if you need to re-baseline, manually ` +
					`\`DELETE FROM schema_version WHERE namespace = '${ns.namespace}'\` first.`,
				{ namespace: ns.namespace }
			);
		}

		for (let i = 0; i < names.length; i++) {
			await tx.query(
				`INSERT INTO schema_version (namespace, name, sequence)
				 VALUES ($1, $2, $3)`,
				[ns.namespace, names[i], i]
			);
		}
	});
};
