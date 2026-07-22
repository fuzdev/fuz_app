import '../assert_dev_env.ts';

/**
 * Cross-impl action-manifest parity — structural diff + assertion over two
 * `ActionManifest`s captured via the `_testing_action_manifest` RPC action.
 *
 * The action-surface twin of `schema_parity.ts`: two live impls (the TS
 * fuz_app spine and the Rust `testing_spine_stub`) are each other's parity
 * reference. After both bootstrap, dump each one's live RPC method set, diff,
 * fail loudly on drift. The diff entries name the specific divergence (a
 * method only one impl mounts, a per-method auth-axis or side-effect
 * mismatch) so the error message points at the source.
 *
 * ```ts
 * const manifest_a = await capture_action_manifest(ts_handle);
 * const manifest_b = await capture_action_manifest(rust_handle);
 * assert_action_manifests_equal(manifest_a, manifest_b, {a: 'ts', b: 'rust'});
 * ```
 *
 * Non-coverage: the manifest captures `{method, side_effects, account, actor,
 * roles, credential_types}` — the wire-relevant auth shape. It does **not**
 * capture input/output schemas (the declared-surface wire shape is gated by
 * `rpc_round_trip`) nor the protocol actions `heartbeat` / `cancel` (excluded
 * by construction — see `action_manifest.ts`).
 *
 * @module
 */

import type { ActionManifest, ActionManifestEntry } from './action_manifest.ts';

/** The auth axes compared as scalars (`'none' | 'optional' | 'required'`). */
const AUTH_SCALAR_FIELDS = ['account', 'actor'] as const satisfies ReadonlyArray<
	keyof ActionManifestEntry
>;
/** The auth axes compared as sorted string lists. */
const AUTH_LIST_FIELDS = ['roles', 'credential_types'] as const satisfies ReadonlyArray<
	keyof ActionManifestEntry
>;

/** Structured drift entry. `where` is the named source impl ('a' or 'b'). */
export type ActionManifestDiff =
	| { readonly kind: 'method_only_in'; readonly where: 'a' | 'b'; readonly method: string }
	| {
			readonly kind: 'side_effects_differ';
			readonly method: string;
			readonly a: boolean;
			readonly b: boolean;
	  }
	| {
			readonly kind: 'auth_field_differs';
			readonly method: string;
			readonly field: 'account' | 'actor' | 'roles' | 'credential_types';
			readonly a: unknown;
			readonly b: unknown;
	  };

/** Positional string-list equality (entries are pre-sorted by `build_action_manifest`). */
const string_lists_equal = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Structural diff between two manifests — empty array means parity holds.
 *
 * Order is deterministic: methods in sorted order, with each method's
 * side-effect + auth-field sub-diffs grouped together.
 */
export const diff_action_manifests = (
	a: ActionManifest,
	b: ActionManifest
): Array<ActionManifestDiff> => {
	const diffs: Array<ActionManifestDiff> = [];
	const a_by = new Map(a.methods.map((m) => [m.method, m]));
	const b_by = new Map(b.methods.map((m) => [m.method, m]));
	const all_methods = new Set([...a_by.keys(), ...b_by.keys()]);
	for (const method of [...all_methods].sort()) {
		const ea = a_by.get(method);
		const eb = b_by.get(method);
		if (!ea) {
			diffs.push({ kind: 'method_only_in', where: 'b', method });
			continue;
		}
		if (!eb) {
			diffs.push({ kind: 'method_only_in', where: 'a', method });
			continue;
		}
		if (ea.side_effects !== eb.side_effects) {
			diffs.push({ kind: 'side_effects_differ', method, a: ea.side_effects, b: eb.side_effects });
		}
		for (const field of AUTH_SCALAR_FIELDS) {
			if (ea[field] !== eb[field]) {
				diffs.push({ kind: 'auth_field_differs', method, field, a: ea[field], b: eb[field] });
			}
		}
		for (const field of AUTH_LIST_FIELDS) {
			if (!string_lists_equal(ea[field], eb[field])) {
				diffs.push({ kind: 'auth_field_differs', method, field, a: ea[field], b: eb[field] });
			}
		}
	}
	return diffs;
};

/** Labels used in formatted output — defaults to `'a'` and `'b'`. */
export interface ActionManifestDiffLabels {
	readonly a?: string;
	readonly b?: string;
}

/**
 * Render a diff list as a human-readable multi-line string. Empty diffs
 * produce an empty string.
 */
export const format_action_manifest_diffs = (
	diffs: ReadonlyArray<ActionManifestDiff>,
	labels: ActionManifestDiffLabels = {}
): string => {
	if (diffs.length === 0) return '';
	const label_a = labels.a ?? 'a';
	const label_b = labels.b ?? 'b';
	const where_label = (where: 'a' | 'b'): string => (where === 'a' ? label_a : label_b);

	const lines: Array<string> = [];
	for (const d of diffs) {
		switch (d.kind) {
			case 'method_only_in':
				lines.push(`  method ${d.method} only in ${where_label(d.where)}`);
				break;
			case 'side_effects_differ':
				lines.push(`  ${d.method} side_effects differs: ${label_a}=${d.a}, ${label_b}=${d.b}`);
				break;
			case 'auth_field_differs':
				lines.push(
					`  ${d.method} auth.${d.field} differs: ${label_a}=${JSON.stringify(d.a)}, ${
						label_b
					}=${JSON.stringify(d.b)}`
				);
				break;
			default:
				// Compile-time exhaustiveness — a new variant without a case here
				// makes `d` non-never and fails type-check.
				d satisfies never;
				break;
		}
	}
	return lines.join('\n');
};

/**
 * Throw if the two manifests disagree. The error message names the impls
 * (via `labels`) and lists every diff, so the failure is self-diagnosing.
 */
export const assert_action_manifests_equal = (
	a: ActionManifest,
	b: ActionManifest,
	labels: ActionManifestDiffLabels = {}
): void => {
	const diffs = diff_action_manifests(a, b);
	if (diffs.length === 0) return;
	const label_a = labels.a ?? 'a';
	const label_b = labels.b ?? 'b';
	throw new Error(
		`Action-manifest parity failed: ${diffs.length} diff(s) between ${label_a} and ${
			label_b
		}\n${format_action_manifest_diffs(diffs, labels)}`
	);
};
