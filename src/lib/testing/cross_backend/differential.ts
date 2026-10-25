import '../assert_dev_env.ts';

/**
 * The cross-backend differential: each impl is the oracle for the other.
 *
 * A conformance case pins its status and reason on one backend at a time,
 * and an output schema is often loose (`z.looseObject`, or Zod's default
 * strip), so an extra field from one spine — possibly a leak — passes, as
 * does any body difference on a case pinned by status alone.
 * `describe_differential_conformance_tests` sends every case to two backends,
 * normalizes both responses (`normalize_differential_response`), and asserts
 * they are equal: status, header names, and the whole body.
 *
 * Each case runs on a fresh fixture per backend — each backend's own
 * `setup_test`, so separate databases and separate keepers, which is why the
 * normalization is positional. The principal resolves and the request is sent
 * through the table runner's own `send_conformance_case`, so a case means the
 * same thing here as in `describe_conformance_table_tests`. The per-case
 * expectations (`expect.status`, `error_reason`, …) are not asserted here —
 * each backend's conformance leg already holds them; the differential holds
 * the two answers to each other.
 *
 * A difference that is tracked and accepted goes in the **known-divergence
 * ledger** (`KnownDivergence`), matched by case names or by methods, naming
 * the paths that differ (`what_differs`), each optionally with the value each
 * side must show there. A case may match several entries and differ at any
 * of their paths, with the declared values, and nowhere else: any other
 * difference fails like any other. The ledger cleans itself, with the
 * `xfail_until` semantics — red when a divergence closes, naming the entry to
 * delete: a case an entry names by `case_name` must still show it, checked in
 * that case's own test, and an entry matched by `method` must still show it on
 * at least one of its cases, checked by a closing test once they have all run.
 * The closing test also fails an entry that matches no case, or that names
 * a case that doesn't exist, and leaves an entry whose cases didn't all run
 * (a `-t` filter, a send that threw) unjudged rather than calling it closed.
 *
 * Use the backends' cross-process fixtures — the differential needs two live
 * backends, so it runs in a dual-spawn project. fuz_app's own wiring is the
 * `cross_backend_parity` project's `differential.cross.test.ts`.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import type { AppSurfaceSpec } from '../../http/surface.ts';
import type { SessionOptions } from '../../auth/session_cookie.ts';
import { resolve_rpc_endpoints_for_setup, type RpcEndpointsSuiteOption } from '../rpc_helpers.ts';
import type { ConformanceCase } from './conformance_case.ts';
import { send_conformance_case, type ConformancePrincipalConfig } from './conformance_table.ts';
import {
	diff_differential_responses,
	differential_path_covers,
	format_differential_diffs,
	normalize_differential_response,
	type DifferentialDiff,
	type DifferentialResponse
} from './differential_normalize.ts';
import type { SetupTest } from './setup.ts';

/** One side of the differential. */
export interface DifferentialBackend {
	/** Short label used in failure output (`ts`, `rust`). */
	readonly name: string;
	/** Per-test fixture producer for this backend. */
	readonly setup_test: SetupTest;
}

/**
 * What a ledger entry matches: cases by name, or every case on a method —
 * one, or a list.
 */
export type KnownDivergenceMatch =
	| { readonly case_name: string | ReadonlyArray<string>; readonly method?: never }
	| { readonly method: string | ReadonlyArray<string>; readonly case_name?: never };

/**
 * One path a known divergence differs at, with what each side must show
 * there.
 *
 * `path` covers itself and everything under it (`differential_path_covers`).
 * `a` / `b`, when given, are the value that side's diff must carry at the
 * differing path — `undefined` meaning the side has nothing there — so a
 * divergence that changes shape (the side that lacked a field starts sending
 * a different one, or the other side's value moves) is no longer covered and
 * fails. Omit a side to leave its value open. A bare string is a path with
 * both sides open.
 *
 * A pin is compared with the normalized leaf value at the differing path: a
 * placeholdered value never matches the raw one, an object pin must list its
 * keys sorted, and a pin on a parent path never matches, since diffs are
 * reported at their leaves.
 */
export interface KnownDivergencePath {
	readonly path: string;
	readonly a?: unknown;
	readonly b?: unknown;
}

/**
 * A tracked, accepted difference between the two backends.
 *
 * `what_differs` lists the normalized-response paths that differ
 * (`DifferentialDiff.path` — `status`, `headers.<name>`,
 * `body.error.data.reason`), each optionally with the value each side shows
 * (`KnownDivergencePath`). A matched case may differ there and nowhere else.
 * An entry naming cases must still differ on each of them; one naming
 * methods, on at least one of its cases.
 *
 * A pin is compared with the normalized leaf value at the differing path: a
 * placeholdered value never matches the raw one, an object pin must list its
 * keys sorted, and a pin on a parent path never matches, since diffs are
 * reported at their leaves.
 */
export type KnownDivergence = KnownDivergenceMatch & {
	/** Tracking id of the divergence (a slug, as `xfail_until` takes). */
	readonly tracking_id: string;
	/** Why the divergence is accepted for now. */
	readonly reason: string;
	/** The normalized-response paths that differ, with any per-side values. */
	readonly what_differs: ReadonlyArray<string | KnownDivergencePath>;
};

/** Options for `describe_differential_conformance_tests`. */
export interface DifferentialConformanceOptions {
	/** The cases to send to both backends, in order. */
	readonly cases: ReadonlyArray<ConformanceCase>;
	/** The two backends; `a` and `b` in diffs are these, in order. */
	readonly backends: readonly [DifferentialBackend, DifferentialBackend];
	/** Surface spec — supplies the `RouteSpec`s for the REST branch. */
	readonly surface_source: AppSurfaceSpec;
	/** RPC endpoints — resolved to find each method's action spec. */
	readonly rpc_endpoints: RpcEndpointsSuiteOption;
	/** Session options — needed to resolve the `rpc_endpoints` factory form. */
	readonly session_options: SessionOptions<string>;
	/** Maps the `role_holder` / `wrong_role` principals to seeded usernames. */
	readonly principals?: ConformancePrincipalConfig;
	/** The tracked divergences these cases may show. */
	readonly known_divergences?: ReadonlyArray<KnownDivergence>;
	/** `describe` block label. Defaults to `'differential conformance'`. */
	readonly suite_name?: string;
}

const as_list = (value: string | ReadonlyArray<string>): ReadonlyArray<string> =>
	typeof value === 'string' ? [value] : value;

/** The ledger entries matching a case. */
const find_known_divergences = (
	c: ConformanceCase,
	ledger: ReadonlyArray<KnownDivergence>
): Array<KnownDivergence> =>
	ledger.filter((d) =>
		d.case_name !== undefined
			? as_list(d.case_name).includes(c.name)
			: as_list(d.method).includes(c.request.method)
	);

/**
 * The ledger's static problems against a case list: an entry that matches no
 * case, and every `case_name` it lists that no case carries — a dead name
 * would otherwise ride along behind a live one in the same entry.
 *
 * Needs no backend; the differential's closing test reports these, and a
 * consumer can check its ledger with it directly.
 *
 * @param cases - the cases the ledger is run against
 * @param ledger - the known divergences
 * @returns one message per problem, empty when the ledger names only real cases
 */
export const check_known_divergence_ledger = (
	cases: ReadonlyArray<ConformanceCase>,
	ledger: ReadonlyArray<KnownDivergence>
): Array<string> => {
	const problems: Array<string> = [];
	const case_names = new Set(cases.map((c) => c.name));
	for (const d of ledger) {
		if (!cases.some((c) => find_known_divergences(c, [d]).length > 0)) {
			problems.push(`'${d.tracking_id}' matches no case — fix its case name or method`);
			continue;
		}
		if (d.case_name !== undefined) {
			const dead = as_list(d.case_name).filter((name) => !case_names.has(name));
			if (dead.length > 0) {
				problems.push(
					`'${d.tracking_id}' names no such case: ${dead.map((n) => `'${n}'`).join(', ')}`
				);
			}
		}
	}
	return problems;
};

const to_divergence_path = (entry: string | KnownDivergencePath): KnownDivergencePath =>
	typeof entry === 'string' ? { path: entry } : entry;

/** Whether `diff` is one `d` declares: under a listed path, with its values. */
const is_covered = (d: KnownDivergence, diff: DifferentialDiff): boolean =>
	d.what_differs.some((entry) => {
		const p = to_divergence_path(entry);
		return (
			differential_path_covers(p.path, diff.path) &&
			(!('a' in p) || is_deep_equal(diff.a, p.a)) &&
			(!('b' in p) || is_deep_equal(diff.b, p.b))
		);
	});

const is_deep_equal = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y);

const format_what_differs = (d: KnownDivergence): string =>
	d.what_differs
		.map((entry) => {
			const p = to_divergence_path(entry);
			const sides = (['a', 'b'] as const)
				.filter((side) => side in p)
				.map((side) => `${side}=${JSON.stringify(p[side]) ?? 'undefined'}`);
			return sides.length > 0 ? `${p.path} (${sides.join(' ')})` : p.path;
		})
		.join(', ');

/**
 * Register a `describe` block sending every case to both backends and
 * asserting their normalized responses are equal, or — for a case in the
 * known-divergence ledger — that they still differ, and only where listed.
 *
 * @param options - the cases, the two backends, and the shared surface
 */
export const describe_differential_conformance_tests = (
	options: DifferentialConformanceOptions
): void => {
	const { cases, backends, surface_source, principals } = options;
	const ledger = options.known_divergences ?? [];
	const resolved_rpc_endpoints = resolve_rpc_endpoints_for_setup(
		options.rpc_endpoints,
		options.session_options
	);
	const [a, b] = backends;
	const labels = { a: a.name, b: b.name };

	const send = async (
		backend: DifferentialBackend,
		c: ConformanceCase
	): Promise<DifferentialResponse> =>
		normalize_differential_response(
			await send_conformance_case(c, {
				fixture: await backend.setup_test(),
				surface_source,
				...(principals && { principals }),
				resolved_rpc_endpoints
			})
		);

	describe(options.suite_name ?? 'differential conformance', () => {
		// per entry: the cases it matched, the ones that ran to a diff, and
		// whether any of them showed it
		const matched = new Map<KnownDivergence, Set<string>>();
		const ran = new Map<KnownDivergence, Set<string>>();
		const observed = new Set<KnownDivergence>();
		for (const c of cases) {
			const known = find_known_divergences(c, ledger);
			for (const d of known) {
				const names = matched.get(d) ?? new Set();
				names.add(c.name);
				matched.set(d, names);
			}
			const label =
				known.length > 0
					? `${c.name} [known: ${known.map((d) => d.tracking_id).join(', ')}]`
					: c.name;
			test(label, async () => {
				const [response_a, response_b] = await Promise.all([send(a, c), send(b, c)]);
				const diffs = diff_differential_responses(response_a, response_b);
				for (const d of known) {
					const names = ran.get(d) ?? new Set();
					names.add(c.name);
					ran.set(d, names);
					if (diffs.some((diff) => is_covered(d, diff))) observed.add(d);
				}
				const unlisted = diffs.filter((diff) => !known.some((d) => is_covered(d, diff)));
				assert.ok(
					unlisted.length === 0,
					`${c.name}: ${a.name} and ${b.name} answered differently` +
						(known.length > 0
							? ` outside known divergences ${known.map((d) => d.tracking_id).join(', ')}`
							: '') +
						`:\n` +
						format_differential_diffs(unlisted, labels)
				);
				// an entry naming this case must still show here
				const closed = known.filter(
					(d) => d.case_name !== undefined && !diffs.some((diff) => is_covered(d, diff))
				);
				assert.ok(
					closed.length === 0,
					`${c.name}: known divergence ${closed.map((d) => `'${d.tracking_id}'`).join(', ')} ` +
						`has closed on this case — ${a.name} and ${b.name} no longer differ at ` +
						`${closed.map(format_what_differs).join('; ')}; drop the case from the entry`
				);
			});
		}
		// Registered after the cases, so it runs once every case has recorded.
		test('every known divergence matches a case and still differs', (ctx) => {
			const problems = check_known_divergence_ledger(cases, ledger);
			let judged = 0;
			let unjudged = 0;
			for (const d of ledger) {
				const names = matched.get(d);
				if (!names) continue;
				// case-named entries are judged in their cases' own tests; a
				// method entry only once every matched case ran, since a filtered
				// or failed run can't tell a closed divergence from an unrun case
				if (d.case_name !== undefined) continue;
				if ((ran.get(d)?.size ?? 0) < names.size) {
					unjudged++;
					continue;
				}
				judged++;
				if (!observed.has(d)) {
					problems.push(
						`'${d.tracking_id}' has closed — ${a.name} and ${b.name} answer the same at ` +
							`${format_what_differs(d)} on every matched case; delete its ledger entry`
					);
				}
			}
			assert.deepEqual(problems, [], 'known-divergence ledger is stale');
			// nothing left to judge: say so rather than pass as if checked
			if (unjudged > 0 && judged === 0) ctx.skip();
		});
	});
};
