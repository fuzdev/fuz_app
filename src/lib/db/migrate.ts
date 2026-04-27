/**
 * Identity-tracked database migration runner.
 *
 * Migrations are named `{name, up}` objects in ordered arrays, grouped by
 * namespace. A `schema_version` table records one row per applied migration —
 * `(namespace, name, sequence, applied_at)` — and the runner verifies the
 * applied list is a name-prefix of the code's migration array at boot.
 *
 * **Append-only after first publish**: once a fuz_app version containing a
 * given migration is published (`npm publish` / `jsr publish`), that
 * migration's name and position are frozen. Never edit, rename, or reorder
 * after publish — append only. Pre-publish, anything goes; the cliff is the
 * publish event. Edits to a published migration's body slip past the runner
 * (no content hashing) and are caught by schema-snapshot tests in consumers.
 *
 * **Chain-level transactions**: All pending migrations in a namespace run in
 * a single transaction. Any failure rolls back every migration in that run —
 * no partial-state recovery. This rules out non-transactional DDL (e.g.,
 * `CREATE INDEX CONCURRENTLY`); run those out of band.
 *
 * **Chain idempotency, not migration idempotency**: the chain-tx wraps every
 * migration replayed in a single boot, so an individual migration may
 * temporarily produce intermediate state that a later migration reverses
 * (e.g. v0's `PERMIT_INDEXES` recreates an index that v1 drops; chain-tx
 * hides this from observers). What matters is that the *committed end state*
 * matches; the in-tx steps may not be individually idempotent against an
 * arbitrary mid-chain target.
 *
 * **Forward-only**: No down-migrations. Schema changes are additive.
 *
 * **Advisory locking**: Per-namespace `pg_advisory_lock` reduces contention
 * in multi-instance deployments — best-effort, not load-bearing. The locks
 * are session-scoped, but `Db.query` runs against a pool that may check out
 * a different backend per call, so two concurrent boots can both "hold"
 * the lock on different sessions. The real serialization comes from chain-
 * tx atomicity + the `(namespace, name)` PK on `schema_version`: the
 * loser's INSERT hits a PK violation, the chain-tx rolls back, and the
 * next boot reads the committed state and proceeds cleanly. Environments
 * without `pg_advisory_lock` (some PGlite versions) silently fall through.
 *
 * @module
 */

import type {Db} from './db.js';

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
 * Array index = position in the chain. Append-only after publish.
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
	| 'binary-older-than-db'
	| 'name-divergence-at-N'
	| 'old-tracker-shape'
	| 'migration-failed'
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
		super(message, context?.cause !== undefined ? {cause: context.cause} : undefined);
		this.name = 'MigrationError';
		this.kind = kind;
		this.namespace = context?.namespace;
		this.at_index = context?.at_index;
		this.unknown_names = context?.unknown_names;
	}
}

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
 * Detect the pre-0.42 `schema_version` shape (`namespace`, `version`,
 * `applied_at`). The new-shape DDL uses `IF NOT EXISTS` and would silently
 * no-op against the old table, so this probe runs before DDL and before any
 * per-namespace lock.
 */
const detect_old_tracker = async (db: Db): Promise<boolean> => {
	const row = await db.query_one<{exists: boolean}>(
		`SELECT EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_schema = 'public'
			  AND table_name = 'schema_version'
			  AND column_name = 'version'
		) as exists`,
	);
	return row?.exists ?? false;
};

const OLD_TRACKER_HINT =
	'Detected fuz_app < 0.42 tracker shape (schema_version.version column exists). ' +
	'Hint: `DROP TABLE schema_version` and re-run, or call `baseline()` first if ' +
	'preserving an existing schema.';

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
 * Run `fn` with the namespace's advisory lock held.
 *
 * Acquire / release are best-effort and silently fall through in
 * environments without `pg_advisory_lock` (some PGlite versions). The
 * `finally` ensures release on any throw from `fn`.
 */
const with_namespace_lock = async <T>(
	db: Db,
	namespace: string,
	fn: () => Promise<T>,
): Promise<T> => {
	const lock_key = namespace_lock_key(namespace);
	try {
		await db.query('SELECT pg_advisory_lock($1)', [lock_key]);
	} catch {
		// Advisory lock not supported — proceed without serialization
	}
	try {
		return await fn();
	} finally {
		try {
			await db.query('SELECT pg_advisory_unlock($1)', [lock_key]);
		} catch {
			// Advisory lock not supported — nothing to release
		}
	}
};

/**
 * Run pending migrations for each namespace.
 *
 * For each namespace: acquires an advisory lock, reads applied rows ordered
 * by `sequence`, length-checks (binary-older-than-db short-circuits), name-
 * prefix-verifies, then runs the pending tail in a single chain transaction.
 * Each migration's row is INSERTed with `sequence = max(sequence) + 1` for
 * the namespace.
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
 * **Concurrency**: per-namespace advisory locks reduce contention in
 * multi-instance deployments but are best-effort on pool drivers (see
 * the module docstring's "Advisory locking" notes). Correctness on concurrent boots
 * falls out of chain-tx atomicity + the `(namespace, name)` PK — the
 * loser's INSERT triggers PK violation and rollback; subsequent boots
 * see the committed state.
 *
 * @param db - the database instance
 * @param namespaces - migration namespaces, processed in the order passed
 * @returns one result per namespace where work happened (already-up-to-date
 *   namespaces are omitted)
 * @mutates schema_version - inserts one row per applied migration
 * @throws MigrationError with `kind` of `binary-older-than-db`,
 *   `name-divergence-at-N`, `old-tracker-shape`, or `migration-failed`
 */
export const run_migrations = async (
	db: Db,
	namespaces: Array<MigrationNamespace>,
): Promise<Array<MigrationResult>> => {
	if (await detect_old_tracker(db)) {
		throw new MigrationError('old-tracker-shape', OLD_TRACKER_HINT);
	}

	await db.query(SCHEMA_VERSION_DDL);

	const results: Array<MigrationResult> = [];

	for (const {namespace, migrations} of namespaces) {
		await with_namespace_lock(db, namespace, async () => {
			const applied = await db.query<{name: string; sequence: number}>(
				`SELECT name, sequence FROM schema_version
				 WHERE namespace = $1
				 ORDER BY sequence ASC`,
				[namespace],
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
					{namespace, unknown_names},
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
						{namespace, at_index: i},
					);
				}
			}

			// Step 5: up-to-date case
			if (applied.length === migrations.length) return;

			// Step 6: run pending tail in a single chain-tx
			let next_sequence = applied.length > 0 ? applied[applied.length - 1]!.sequence + 1 : 0;
			const applied_names: Array<string> = [];

			await db.transaction(async (tx) => {
				for (let i = applied.length; i < migrations.length; i++) {
					const m = migrations[i]!;
					try {
						await m.up(tx);
						await tx.query(
							`INSERT INTO schema_version (namespace, name, sequence)
							 VALUES ($1, $2, $3)`,
							[namespace, m.name, next_sequence],
						);
						applied_names.push(m.name);
						next_sequence++;
					} catch (err) {
						if (err instanceof MigrationError) throw err;
						throw new MigrationError(
							'migration-failed',
							`Migration ${namespace}["${m.name}"] failed: ` +
								`${err instanceof Error ? err.message : String(err)}. ` +
								`Hint: fix the migration body and retry; the chain is left at the prior committed version.`,
							{namespace, at_index: i, cause: err},
						);
					}
				}
			});

			results.push({namespace, applied_names});
		});
	}

	return results;
};

/**
 * Insert tracker rows for the named migrations of a namespace **without
 * executing them**.
 *
 * Used to promote an existing schema (e.g. produced by a pre-0.42 build,
 * preserved through a tracker-shape upgrade) into the new identity tracker.
 * `baseline()` trusts the operator-supplied list — it does not verify that
 * the schema actually matches what the named migrations would have produced.
 * Pair with a schema-assertion script post-baseline before re-enabling traffic.
 *
 * Contract:
 * - Probes for the pre-0.42 tracker shape; throws `old-tracker-shape` if
 *   found (DDL with `IF NOT EXISTS` would otherwise no-op against the old
 *   table and the INSERT would fail with a confusing column-not-found).
 * - Creates the new-shape `schema_version` table if missing — cutover
 *   scripts that just dropped the old-shape table can call `baseline()`
 *   directly with no separate DDL step.
 * - Acquires the same per-namespace advisory lock as `run_migrations` (with
 *   the same try/catch fallback for environments lacking `pg_advisory_lock`).
 * - Refuses if any tracker rows already exist *for this namespace* — lets
 *   multi-call baseline scripts resume after partial failure (completed
 *   namespaces guard themselves while remaining ones still run).
 * - Verifies the supplied names are a strict prefix of the namespace's
 *   current migrations array — a name not in the array, or out of order,
 *   errors before any INSERT.
 * - Writes sequences `0..N-1` in one transaction.
 *
 * @param db - the database instance
 * @param ns - the namespace whose migrations are being baselined
 * @param names - prefix of `ns.migrations[].name` to record as already-applied
 * @mutates schema_version - inserts tracker rows for `names` without running
 *   the corresponding migration bodies
 * @throws MigrationError with `kind` of `old-tracker-shape`,
 *   `baseline-name-not-in-code`, `baseline-name-out-of-order`, or
 *   `baseline-namespace-already-populated`
 */
export const baseline = async (
	db: Db,
	ns: MigrationNamespace,
	names: ReadonlyArray<string>,
): Promise<void> => {
	if (await detect_old_tracker(db)) {
		throw new MigrationError('old-tracker-shape', OLD_TRACKER_HINT, {namespace: ns.namespace});
	}

	await db.query(SCHEMA_VERSION_DDL);

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
				{namespace: ns.namespace},
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
				{namespace: ns.namespace, at_index: i},
			);
		}
	}

	await with_namespace_lock(db, ns.namespace, async () => {
		const existing = await db.query<{name: string}>(
			'SELECT name FROM schema_version WHERE namespace = $1 LIMIT 1',
			[ns.namespace],
		);
		if (existing.length > 0) {
			throw new MigrationError(
				'baseline-namespace-already-populated',
				`baseline: namespace "${ns.namespace}" already has tracker rows. ` +
					`Hint: per-namespace guard for partial-failure resume — completed namespaces ` +
					`self-skip; if you need to re-baseline, manually ` +
					`\`DELETE FROM schema_version WHERE namespace = '${ns.namespace}'\` first.`,
				{namespace: ns.namespace},
			);
		}

		await db.transaction(async (tx) => {
			for (let i = 0; i < names.length; i++) {
				await tx.query(
					`INSERT INTO schema_version (namespace, name, sequence)
					 VALUES ($1, $2, $3)`,
					[ns.namespace, names[i], i],
				);
			}
		});
	});
};
