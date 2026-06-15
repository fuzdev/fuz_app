import '../assert_dev_env.js';

/**
 * Reconcile a backend's **live-mounted** RPC method set against a tagged
 * coverage manifest, so the off-declared-surface methods stay as drift-proof
 * as the declared ones.
 *
 * The spec-derived suites (`describe_rpc_round_trip_tests` /
 * `describe_rpc_attack_surface_tests`) auto-enumerate the **declared**
 * surface — add a method to a registry in `create_spine_surface_spec` and it
 * is tested automatically. But a backend's live RPC endpoint also mounts
 * methods kept *off* that surface (stateful cell verbs, opt-in resolvers,
 * `_testing_*` backdoors); those rely on hand-wired imperative suites and get
 * no auto-enumeration. Nothing structurally guaranteed every live method was
 * actually claimed by a suite — so a newly mounted-but-untested method could
 * ship silently.
 *
 * {@link assert_rpc_method_coverage} closes that gap: it diffs the live method
 * set against a {@link MethodCoverageEntry} manifest (both directions — a
 * mounted-but-unclaimed method *and* a stale manifest row both fail loud) and
 * checks each entry's tier is consistent with the declared surface + the
 * backdoor prefix. The manifest becomes the forcing function — a new method
 * can't reach the live mount without a manifest row naming the suite that
 * covers it.
 *
 * Pairs with `surface_invariants.ts` `assert_no_testing_methods` (which guards
 * the *reverse* — a backdoor must never leak *onto* the declared surface).
 *
 * @module
 */

import {assert} from 'vitest';

import type {BackendCapabilities} from './capabilities.js';

/** How a live-mounted RPC method earns its cross-backend coverage. */
export type MethodCoverageTier =
	/**
	 * On the declared surface (`create_spine_surface_spec`). Auto-enumerated by
	 * the spec-derived round-trip + attack-surface suites — no bespoke suite
	 * needed.
	 */
	| 'declared'
	/**
	 * Live-mounted but deliberately off the declared surface (stateful or
	 * opt-in). Covered only by a dedicated imperative `describe_*_cross_tests`
	 * suite, so the entry must name it.
	 */
	| 'off_surface'
	/**
	 * A `_testing_*` daemon-token backdoor — live-mounted on the test binary,
	 * never on the declared surface. Coverage is the credential-gate suite plus
	 * the in-process spec-level gate test.
	 */
	| 'backdoor';

/** One row of the live-RPC-method coverage manifest. */
export interface MethodCoverageEntry {
	/** The RPC method name (`action.spec.method`). */
	readonly method: string;
	/** How this method is covered. */
	readonly tier: MethodCoverageTier;
	/**
	 * The `BackendCapabilities` flag gating this method's cross suite, when it
	 * is capability-gated. Typed against the real interface so a stale flag is a
	 * compile error. Omit for ungated off-surface families (always-mounted, the
	 * suite runs unconditionally) and for declared / backdoor tiers.
	 */
	readonly capability?: keyof BackendCapabilities;
	/**
	 * The cross-backend suite (or test file) that covers this method.
	 * **Required** for `off_surface` — the manifest's whole point is to name the
	 * suite a method without auto-enumeration relies on. Optional for
	 * `declared` (auto-enumerated) / `backdoor` (infra).
	 */
	readonly suite?: string;
	/** Optional free-text note printed nowhere — documentation for the reader. */
	readonly note?: string;
}

/** Inputs for {@link assert_rpc_method_coverage}. */
export interface RpcMethodCoverageInput {
	/** Every method the live RPC endpoint mounts (`action.spec.method`). */
	readonly live_methods: ReadonlyArray<string>;
	/** The declared-surface method names (from `create_*_surface_spec`). */
	readonly declared_methods: ReadonlyArray<string>;
	/** The tagged manifest the live set must reconcile against. */
	readonly manifest: ReadonlyArray<MethodCoverageEntry>;
	/** Backdoor method prefix. Defaults to `'_testing_'`. */
	readonly testing_method_prefix?: string;
}

const sorted = (set: Iterable<string>): string => [...set].sort().join('\n  ');

/**
 * Assert the live RPC method set reconciles exactly with the coverage
 * manifest, and that every manifest entry's tier is internally consistent.
 *
 * Fails loud on: a live method missing from the manifest (mounted-but-unclaimed),
 * a manifest row naming a method the live mount no longer exposes (stale row),
 * a declared-surface method absent from the live mount (the full mount must be
 * a superset), a duplicate manifest entry, or any tier/declared/backdoor
 * inconsistency (e.g. an `off_surface` row that is actually on the declared
 * surface, or one missing its `suite`).
 *
 * @throws AssertionError naming the specific divergence.
 */
export const assert_rpc_method_coverage = (input: RpcMethodCoverageInput): void => {
	const prefix = input.testing_method_prefix ?? '_testing_';
	const live = new Set(input.live_methods);
	const declared = new Set(input.declared_methods);

	const manifest_methods = new Set<string>();
	for (const entry of input.manifest) {
		assert.ok(
			!manifest_methods.has(entry.method),
			`method coverage: duplicate manifest entry for '${entry.method}'`,
		);
		manifest_methods.add(entry.method);
	}

	const unclaimed = [...live].filter((m) => !manifest_methods.has(m));
	assert.ok(
		unclaimed.length === 0,
		`method coverage: ${unclaimed.length} live-mounted RPC method(s) absent from the coverage ` +
			`manifest — add a {method, tier, suite} entry for each (or stop mounting it):\n  ${sorted(
				unclaimed,
			)}`,
	);

	const stale = [...manifest_methods].filter((m) => !live.has(m));
	assert.ok(
		stale.length === 0,
		`method coverage: ${stale.length} manifest entr(y/ies) name a method the live mount no longer ` +
			`exposes — remove the stale row(s):\n  ${sorted(stale)}`,
	);

	const declared_not_live = [...declared].filter((m) => !live.has(m));
	assert.ok(
		declared_not_live.length === 0,
		`method coverage: ${declared_not_live.length} declared-surface method(s) not present in the ` +
			`live mount — the full mount must be a superset of the declared surface:\n  ${sorted(
				declared_not_live,
			)}`,
	);

	for (const entry of input.manifest) {
		const is_backdoor = entry.method.startsWith(prefix);
		const is_declared = declared.has(entry.method);
		switch (entry.tier) {
			case 'declared':
				assert.ok(
					is_declared,
					`method coverage: '${entry.method}' is tagged 'declared' but is not on the declared ` +
						`surface (create_*_surface_spec) — retag it 'off_surface' or 'backdoor'`,
				);
				assert.ok(
					!is_backdoor,
					`method coverage: '${entry.method}' is tagged 'declared' but starts with '${prefix}' ` +
						`(backdoors must never reach the declared surface) — retag it 'backdoor'`,
				);
				break;
			case 'backdoor':
				assert.ok(
					is_backdoor,
					`method coverage: '${entry.method}' is tagged 'backdoor' but does not start with ` +
						`'${prefix}'`,
				);
				assert.ok(
					!is_declared,
					`method coverage: '${entry.method}' is tagged 'backdoor' but appears on the declared ` +
						`surface — a '${prefix}*' action must be live-mounted only`,
				);
				break;
			case 'off_surface':
				assert.ok(
					!is_declared,
					`method coverage: '${entry.method}' is tagged 'off_surface' but is on the declared ` +
						`surface — retag it 'declared' (the spec-derived suites already enumerate it)`,
				);
				assert.ok(
					!is_backdoor,
					`method coverage: '${entry.method}' is tagged 'off_surface' but starts with '${prefix}' ` +
						`— retag it 'backdoor'`,
				);
				assert.ok(
					!!entry.suite,
					`method coverage: off-surface method '${entry.method}' must name the cross-backend ` +
						`'suite' that covers it — it gets no auto-enumeration`,
				);
				break;
		}
	}
};
