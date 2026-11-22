/**
 * The transcript differential: imperative cross suites run once per backend,
 * every request and answer recorded (`transcript_record.ts`), and each
 * test's two transcripts normalized and diffed (`transcript_normalize.ts`).
 *
 * The suites assert what their authors thought to assert. The transcript
 * compares everything else they send and read — whole bodies, statuses,
 * header names and the values of `COMPARED_HEADER_VALUES`, the session
 * cookie's effect and lines, the names of every cookie set, timestamps as
 * offsets within the test, audit `seq` — with each backend the oracle for
 * the other. It can't see a bug both backends share, nor a request no suite
 * sends, so it rides beside the suites' own assertions, never in place of
 * them.
 *
 * Side A's `describe` runs every suite first and stores each test's
 * transcript; side B's runs them again and, in its `afterEach`, diffs against
 * A's for the same test, so a difference fails side B's test whichever side
 * owns it (the message carries both sides' values). The cross projects run
 * one file at a time, with no concurrent tests, so A finishes before B starts.
 * A test side B runs that side A didn't record fails there.
 *
 * With `compare_db_state`, each test also compares the databases the two
 * backends are left in (`create_db_state_probe`, read directly — both must be
 * on PostgreSQL the test process reaches): side A's `afterEach` stores its
 * normalized state beside the transcript, and side B's diffs against it, the
 * differences named under `db.` (`[db]` in a failure) for the ledger to
 * match by `path` (a row with `where` matches no database difference).
 *
 * Known differences are a ledger of the transcript's own
 * (`TranscriptKnownDivergence`), matched by path within an entry. A closing
 * test fails when a test ran on one side and not the other (filtered runs
 * included: a filter applies to both sides alike), and, on a whole run —
 * every registered test ran on both sides — when a ledger row matched
 * nothing; on a partial run it skips, saying which check it left unjudged.
 * A gated skip (`test_if`) is held to `expected_skips` on both sides and left
 * out of the whole-run count, so a declared skip on both sides leaves the
 * ledger judged; an undeclared one, or a declared one that runs, fails here.
 * Any other skip makes every run partial, so the ledger then goes unjudged
 * until it is removed; and a retried test records twice and fails here, so
 * these files take no `retry`.
 *
 * To investigate a failure, set `FUZ_TEST_TRANSCRIPT_DUMP_DIR`
 * (`TRANSCRIPT_DUMP_DIR_ENV`) to a directory: the closing test writes both
 * sides' raw transcripts (`raw.json`), their normalized forms keyed by test
 * (`transcripts.json`, what was diffed) and the run's counts (`stats.json`).
 *
 * @module
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, assert, beforeAll, beforeEach, describe, test } from 'vitest';

import { describe_account_lifecycle_cross_tests } from '#lib/testing/cross_backend/account_lifecycle.ts';
import { describe_cookie_attributes_cross_tests } from '#lib/testing/cross_backend/cookie_attributes.ts';
import {
	assert_declared_skip_reasons,
	DECLARED_SKIPS_CHECK_NAME,
	find_declared_skip_problems,
	is_gated_skip,
	type CollectedTest
} from '#lib/testing/cross_backend/declared_skips.ts';
import { differential_path_covers } from '#lib/testing/cross_backend/differential_normalize.ts';
import { describe_identity_parity_cross_tests } from '#lib/testing/cross_backend/identity_parity.ts';
import {
	create_db_state_probe,
	diff_db_states,
	type DbState,
	type DbStateMark,
	type DbStateProbe
} from '#lib/testing/cross_backend/db_state_diff.ts';
import { describe_role_grant_offer_lifecycle_cross_tests } from '#lib/testing/cross_backend/role_grant_offer_lifecycle.ts';
import {
	default_cross_process_setup,
	type ReconstructedBootstrappedBackendHandle,
	type SetupTest
} from '#lib/testing/cross_backend/setup.ts';

import {
	diff_transcripts,
	normalize_transcript,
	type NormalizedTranscript,
	type TranscriptDiff,
	type TranscriptSeqBase
} from './transcript_normalize.ts';
import {
	install_create_account_recorder,
	record_setup_test,
	uninstall_create_account_recorder,
	type TranscriptEntry
} from './transcript_record.ts';

/** The env var naming the directory a run's transcripts are written to. */
export const TRANSCRIPT_DUMP_DIR_ENV = 'FUZ_TEST_TRANSCRIPT_DUMP_DIR';

/**
 * A known difference between the two sides' transcripts. `path` is relative
 * to one entry (`response.body.issues`), so a row covers every entry where it
 * shows, narrowed by `where`; `a` / `b` pin the normalized value a side has
 * there, `undefined` for nothing.
 */
export interface TranscriptKnownDivergence {
	readonly tracking_id: string;
	readonly reason: string;
	/** Test keys (`describe > … > test`) the row may match; every test when absent. */
	readonly tests?: ReadonlyArray<string>;
	/** The entries the row may match: both sides' responses carry this status and `error`. */
	readonly where?: {
		readonly status: number;
		readonly body_error: ReadonlyArray<string>;
	};
	readonly what_differs: ReadonlyArray<{
		readonly path: string;
		readonly a?: unknown;
		readonly b?: unknown;
	}>;
}

/** One backend of the transcript differential. */
export interface TranscriptSide {
	readonly name: string;
	readonly handle: ReconstructedBootstrappedBackendHandle;
}

/** Options for `describe_transcript_differential`. */
export interface TranscriptDifferentialOptions {
	readonly sides: readonly [TranscriptSide, TranscriptSide];
	readonly ledger: ReadonlyArray<TranscriptKnownDivergence>;
	/**
	 * A directory the closing test writes both sides' transcripts to, raw and
	 * normalized, with the run's counts, for inspecting a run; nothing is
	 * written without it.
	 */
	readonly dump_dir?: string;
	/** Compare the database each test leaves too (module doc). */
	readonly compare_db_state?: boolean;
	/**
	 * The gated skips both sides owe (`test_if` cases skipped for what the
	 * backends lack), each by its test key with a reason; default none. Held
	 * on each side by `find_declared_skip_problems`, and left out of the
	 * whole-run count, so a declared skip doesn't leave the ledger unjudged.
	 */
	readonly expected_skips?: Readonly<Record<string, string>>;
}

/** The `index` of a database difference, which belongs to no entry. */
const DB_DIFF_INDEX = -1;

const is_deep_equal = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y);

const entry_matches_where = (
	where: NonNullable<TranscriptKnownDivergence['where']>,
	entry: Record<string, unknown> | undefined
): boolean => {
	const response = entry?.response as { status?: unknown; body?: unknown } | null | undefined;
	if (!response || response.status !== where.status) return false;
	const body = response.body as { error?: unknown } | null | undefined;
	return typeof body?.error === 'string' && where.body_error.includes(body.error);
};

const covers = (
	row: TranscriptKnownDivergence,
	key: string,
	diff: TranscriptDiff,
	entry_a: Record<string, unknown> | undefined,
	entry_b: Record<string, unknown> | undefined
): boolean =>
	(row.tests === undefined || row.tests.includes(key)) &&
	(row.where === undefined ||
		(entry_matches_where(row.where, entry_a) && entry_matches_where(row.where, entry_b))) &&
	row.what_differs.some(
		(p) =>
			differential_path_covers(p.path, diff.path) &&
			(!('a' in p) || is_deep_equal(diff.a, p.a)) &&
			(!('b' in p) || is_deep_equal(diff.b, p.b))
	);

const format_value = (v: unknown): string => JSON.stringify(v) ?? 'undefined';

interface Task {
	readonly name: string;
	readonly type: string;
	readonly mode?: string;
	readonly meta?: object;
	readonly suite?: Task;
	readonly tasks?: ReadonlyArray<Task>;
	readonly result?: { readonly state?: string; readonly errors?: ReadonlyArray<unknown> };
}

/** The test's name path below `root`, joined with `' > '`. */
const key_below = (task: Task, root: Task): string => {
	const names = [task.name];
	for (let s = task.suite; s && s !== root; s = s.suite) names.unshift(s.name);
	return names.join(' > ');
};

/** Every test under `suite`, depth first. */
/** The tests under `suite`, less a nested `check_declared_skips` scope and its check. */
const collect_tests = (suite: Task): Array<Task> =>
	(suite.tasks ?? []).flatMap((t) =>
		t.type === 'test'
			? t.name === DECLARED_SKIPS_CHECK_NAME
				? []
				: [t]
			: (t.tasks ?? []).some((x) => x.type === 'test' && x.name === DECLARED_SKIPS_CHECK_NAME)
				? []
				: collect_tests(t)
	);

/** Whether a test will run — a `-t` filter, `.only` elsewhere or `test.skip` marks the rest `skip`. */
const will_run = (test: Task): boolean => test.mode === 'run' || test.mode === 'only';

const test_failed = (task: Task): boolean =>
	task.result?.state === 'fail' || (task.result?.errors?.length ?? 0) > 0;

/** The imperative suites, with the options `SUITE_ENTRIES` derives for each. */
const describe_suites = (
	handle: ReconstructedBootstrappedBackendHandle,
	setup: () => SetupTest
): void => {
	const { config } = handle;
	describe_cookie_attributes_cross_tests({ setup_test: setup(), cookie_name: config.cookie_name });
	describe_identity_parity_cross_tests({ setup_test: setup() });
	describe_account_lifecycle_cross_tests({
		setup_test: setup(),
		capabilities: config.capabilities,
		rpc_path: config.rpc_path
	});
	describe_role_grant_offer_lifecycle_cross_tests({
		setup_test: setup(),
		rpc_path: config.rpc_path
	});
};

/** Side A's record of one test. */
interface StoredTranscript {
	readonly transcript: NormalizedTranscript;
	/** No earlier test on side A failed, so its audit history matches a clean run's. */
	readonly history_clean: boolean;
	/** `seq_base` less the previous `seq_base` on side A, `null` for the first. */
	readonly seq_step: TranscriptSeqBase | null;
	/** The database the test left, with `compare_db_state`. */
	readonly db_state: DbState | null;
}

/**
 * Register the imperative suites once per side and the closing check.
 *
 * @param options - the two backends and the ledger
 */
export const describe_transcript_differential = (options: TranscriptDifferentialOptions): void => {
	const { sides, ledger } = options;
	const [a, b] = sides;
	const cookie_name = a.handle.config.cookie_name;
	const stored_a: Map<string, StoredTranscript> = new Map();
	const paired: Set<string> = new Set();
	const matched_rows: Set<TranscriptKnownDivergence> = new Set();
	/**
	 * Per side, the keys of the tests set to run, how many tests are
	 * registered less the gated skips, and every test by key.
	 */
	const running: Record<string, Array<string>> = {};
	const registered: Record<string, number> = {};
	const collected: Record<string, Array<CollectedTest>> = {};
	const expected_skips = options.expected_skips ?? {};
	assert_declared_skip_reasons(expected_skips, 'describe_transcript_differential: expected_skips');
	const failed_so_far: Record<string, boolean> = { [a.name]: false, [b.name]: false };
	const last_seq_base: Record<string, number | null> = { [a.name]: null, [b.name]: null };
	const sizes: Record<string, Array<number>> = { [a.name]: [], [b.name]: [] };
	const normalized_b: Map<string, NormalizedTranscript> = new Map();
	const raw: Record<string, Record<string, Array<TranscriptEntry>>> = {
		[a.name]: {},
		[b.name]: {}
	};

	describe('transcript differential', () => {
		beforeAll(install_create_account_recorder);
		afterAll(uninstall_create_account_recorder);

		for (const side of sides) {
			const title = `transcript ${side.name}`;
			describe(title, () => {
				let root: Task | null = null;
				let current: Array<TranscriptEntry> | null = null;
				const probe: DbStateProbe | null = options.compare_db_state
					? create_db_state_probe(side.handle)
					: null;
				let mark: DbStateMark | null = null;
				afterAll(async () => {
					await probe?.close();
				});
				const setup = (): SetupTest =>
					record_setup_test(
						default_cross_process_setup(side.handle, { reject_unknown_audit_metadata_keys: true }),
						() => current,
						side.handle.config.base_url
					);

				// vitest passes the suite a hook is registered on as the second argument,
				// and requires the first be destructured
				// eslint-disable-next-line no-empty-pattern
				beforeAll(({}, suite) => {
					root = suite;
					const tests = collect_tests(root);
					collected[side.name] = tests.map((t) => ({
						path: key_below(t, suite),
						gated_skip: is_gated_skip(t)
					}));
					// a gated skip is held to `expected_skips` below, not counted as
					// a test the run left out
					registered[side.name] = tests.filter((t) => !is_gated_skip(t)).length;
					running[side.name] = tests.filter(will_run).map((t) => key_below(t, suite));
				});
				beforeEach(async () => {
					current = [];
					mark = probe ? await probe.mark() : null;
				});
				afterEach(async (ctx) => {
					const entries = current;
					current = null;
					const db_state = probe && mark ? await probe.read(mark) : null;
					mark = null;
					if (!entries || !root) return;
					const key = key_below(ctx.task, root);
					const history_clean = !failed_so_far[side.name];
					if (test_failed(ctx.task)) failed_so_far[side.name] = true;
					sizes[side.name]!.push(JSON.stringify(entries).length);
					if (options.dump_dir) raw[side.name]![key] = entries;
					const transcript = normalize_transcript(entries, cookie_name);
					const { seq_base } = transcript;
					const last = last_seq_base[side.name] ?? null;
					const seq_step =
						seq_base && last !== null
							? { index: seq_base.index, value: seq_base.value - last }
							: null;
					if (seq_base) last_seq_base[side.name] = seq_base.value;
					if (side === a) {
						assert.ok(!stored_a.has(key), `transcript: test key recorded twice: ${key}`);
						stored_a.set(key, { transcript, history_clean, seq_step, db_state });
						return;
					}
					assert.ok(!normalized_b.has(key), `transcript: test key recorded twice: ${key}`);
					normalized_b.set(key, transcript);
					const other = stored_a.get(key);
					assert.ok(
						other,
						`transcript: ${key}\nran on ${b.name} with no ${a.name} transcript to diff against ` +
							`(registered or skipped on one side only)`
					);
					paired.add(key);
					const entries_a = other.transcript.entries;
					const entries_b = transcript.entries;
					const { diffs, misalignment } = diff_transcripts(entries_a, entries_b);
					// the absolute `seq` base is comparable only while both sides' runs went alike
					const seq_a = other.seq_step;
					const seq_b = seq_step;
					if (
						other.history_clean &&
						history_clean &&
						seq_a &&
						seq_b &&
						seq_a.value !== seq_b.value
					) {
						diffs.push({ index: seq_a.index, path: 'seq_step', a: seq_a.value, b: seq_b.value });
					}
					// the database differences carry no entry, `DB_DIFF_INDEX`
					if (other.db_state && db_state) {
						for (const d of diff_db_states(other.db_state, db_state)) {
							diffs.push({ ...d, index: DB_DIFF_INDEX });
						}
					}
					const row_covers = (row: TranscriptKnownDivergence, d: TranscriptDiff): boolean =>
						covers(row, key, d, entries_a[d.index], entries_b[d.index]);
					for (const row of ledger) {
						if (diffs.some((d) => row_covers(row, d))) matched_rows.add(row);
					}
					const unlisted = diffs.filter((d) => !ledger.some((row) => row_covers(row, d)));
					const problems: Array<string> = [];
					if (unlisted.length > 0) {
						const first = unlisted.find((d) => d.index !== DB_DIFF_INDEX)?.index;
						problems.push(
							`${a.name} and ${b.name} answered differently:\n` +
								unlisted
									.map(
										(d) =>
											`  [${d.index === DB_DIFF_INDEX ? 'db' : d.index}] ${d.path}: ` +
											`${a.name}=${format_value(d.a)} ${b.name}=${format_value(d.b)}`
									)
									.join('\n') +
								(first === undefined
									? ''
									: `\nfirst differing entry [${first}]:\n  ${a.name}: ${JSON.stringify(entries_a[first])}\n  ${b.name}: ${JSON.stringify(entries_b[first])}`)
						);
					}
					if (unlisted.some((d) => d.path === 'seq_step')) {
						problems.push(
							'seq_step is how far the smallest audit `seq` this test read sits past the previous ' +
								"test's: the audit rows, rolled-back inserts included, written between the two"
						);
					}
					if (misalignment) {
						problems.push(
							`transcripts stop lining up at entry [${misalignment.index}] ` +
								`(${entries_a.length} entries on ${a.name}, ${entries_b.length} on ${b.name}):\n` +
								`  ${a.name}: ${format_value(misalignment.a)}\n  ${b.name}: ${format_value(misalignment.b)}`
						);
					}
					assert.ok(problems.length === 0, `transcript: ${key}\n${problems.join('\n')}`);
				});

				describe_suites(side.handle, setup);
			});
		}

		test('every test paired, every ledger row matched', (ctx) => {
			const sum = (xs: Array<number>) => xs.reduce((n, x) => n + x, 0);
			const running_a = running[a.name] ?? [];
			const running_b = running[b.name] ?? [];
			const stats = {
				paired: paired.size,
				registered,
				running: { [a.name]: running_a.length, [b.name]: running_b.length },
				matched_rows: [...matched_rows].map((r) => r.tracking_id),
				sides: Object.fromEntries(
					sides.map((s) => [
						s.name,
						{ transcripts: sizes[s.name]!.length, raw_bytes: sum(sizes[s.name]!) }
					])
				)
			};
			if (options.dump_dir) {
				mkdirSync(options.dump_dir, { recursive: true });
				writeFileSync(join(options.dump_dir, 'stats.json'), JSON.stringify(stats, null, '\t'));
				writeFileSync(
					join(options.dump_dir, 'transcripts.json'),
					JSON.stringify(
						{
							[a.name]: Object.fromEntries([...stored_a].map(([k, v]) => [k, v.transcript])),
							[b.name]: Object.fromEntries(normalized_b)
						},
						null,
						'\t'
					)
				);
				writeFileSync(join(options.dump_dir, 'raw.json'), JSON.stringify(raw));
			}
			// with both sides running, every test runs on both: a filter matches
			// both sides' copies of a test alike, so a one-sided key is a test
			// registered or skipped on one side only
			const both_ran = running_a.length > 0 && running_b.length > 0;
			if (both_ran) {
				const set_a = new Set(running_a);
				const set_b = new Set(running_b);
				const one_sided = [
					...running_a.filter((k) => !set_b.has(k)).map((k) => `${a.name} only: ${k}`),
					...running_b.filter((k) => !set_a.has(k)).map((k) => `${b.name} only: ${k}`)
				];
				assert.deepEqual(one_sided, [], 'transcript differential: tests that ran on one side');
			}
			// the paths are read at collection, so a filtered run checks them too
			const skip_problems = sides.flatMap((s) => {
				const tests = collected[s.name];
				return tests
					? find_declared_skip_problems(expected_skips, tests).map((p) => `${s.name}: ${p}`)
					: [];
			});
			assert.deepEqual(skip_problems, [], 'transcript differential: gated skips');
			// a ledger row is judged only on a whole run: a filtered or partly
			// skipped one may leave out the tests a row covers
			const whole =
				both_ran &&
				running_a.length === registered[a.name] &&
				running_b.length === registered[b.name];
			if (!whole) {
				ctx.skip(
					`stale ledger rows unjudged: ${running_a.length} of ${registered[a.name] ?? 0} ` +
						`${a.name} tests and ${running_b.length} of ${registered[b.name] ?? 0} ${b.name} ` +
						'tests ran (a filter, `.only` or a skip)' +
						(both_ran ? '; the one-sided-test check ran' : '; no side-by-side check ran')
				);
			}
			const stale = ledger
				.filter((row) => !matched_rows.has(row))
				.map((row) => `'${row.tracking_id}' matched no difference; delete it`);
			assert.deepEqual(stale, [], 'transcript differential: stale ledger rows');
		});
	});
};
