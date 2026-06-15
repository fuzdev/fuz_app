import '../assert_dev_env.js';

/**
 * Cross-impl RPC **action-manifest** introspection — a normalized,
 * JSON-serializable dump of a backend's live RPC method set, one entry per
 * method carrying its auth shape + side-effect flag.
 *
 * The sibling of `schema_introspect.ts`'s `SchemaSnapshot`: where that
 * captures the live *database* shape for the schema-parity gate, this
 * captures the live *RPC registry* shape for the action-manifest parity gate.
 * Both are dumped over a daemon-token `_testing_*` introspection action
 * (`_testing_action_manifest` here, `_testing_schema_snapshot` there) and
 * diffed across the TS spine and the Rust `testing_spine_stub` so a
 * method-set or per-method auth-shape divergence fails loud. This complements
 * the in-repo `spine_method_coverage` gate: that proves *mounted ⟹ covered*;
 * this proves *TS-mount-set ≡ Rust-mount-set* (method set + auth shape).
 *
 * **Scope — domain + testing surface, not wire protocol.** The manifest is
 * built from exactly the spec list its caller passes
 * (`build_full_spine_rpc_actions` on the TS spine; the spec list minus
 * `PROTOCOL_ACTION_SPECS` on the Rust stub). The protocol actions
 * (`heartbeat` / `cancel`) are excluded by the caller on purpose: the two
 * impls organize them differently (the TS spine mounts them on the WS
 * endpoint only, never the HTTP-RPC endpoint; the Rust stub compiles one
 * shared registry serving both transports), so including them would be a
 * spurious cross-impl diff. This matches the scope of the in-repo
 * `spine_method_coverage` gate (also over `build_full_spine_rpc_actions`).
 *
 * Paired with `action_manifest_parity.ts` for the diff + assertion helpers.
 *
 * `$lib`-free by contract — reached by the spawned TS binary (via
 * `testing_reset_actions.ts` → `full_spine_mount.ts`), so every import is
 * relative.
 *
 * @module
 */

import {z} from 'zod';

import {AuthAxisState, type RouteAuth} from '../../http/auth_shape.js';
import type {RequestResponseActionSpec} from '../../actions/action_spec.js';

/**
 * One method's normalized RPC metadata — the cross-impl-comparable unit.
 * `roles` / `credential_types` are always present + sorted (an absent gate
 * and an empty list both serialize to `[]`) so the diff never trips on a
 * `undefined`-vs-`[]` or declaration-order difference between impls; the
 * auth axes reuse the canonical `AuthAxisState` enum.
 */
export const ActionManifestEntry = z.strictObject({
	/** RPC method name (`spec.method`). */
	method: z.string(),
	/** `true` when the action declares `side_effects` (mutation; POST-only on the RPC transport). */
	side_effects: z.boolean(),
	/** The `account` auth axis. */
	account: AuthAxisState,
	/** The `actor` auth axis. */
	actor: AuthAxisState,
	/** Required roles (any-of), sorted; `[]` when the action declares no role gate. */
	roles: z.array(z.string()),
	/** Permitted credential channels, sorted; `[]` when ungated (any credential). */
	credential_types: z.array(z.string()),
});
export type ActionManifestEntry = z.infer<typeof ActionManifestEntry>;

/** The full action manifest — every entry, sorted by `method`. */
export const ActionManifest = z.strictObject({
	methods: z.array(ActionManifestEntry),
});
export type ActionManifest = z.infer<typeof ActionManifest>;

/** Sorted copy of a readonly string list (stable cross-impl ordering). */
const sorted_strings = (xs: ReadonlyArray<string> | undefined): Array<string> =>
	[...(xs ?? [])].sort();

/**
 * Normalize one spec's auth + side-effects into a manifest entry. Pulls the
 * four auth axes off `RouteAuth` (the same shape the Rust `AuthSpec` mirrors)
 * and flattens optional `roles` / `credential_types` to sorted arrays.
 */
export const action_manifest_entry = (spec: {
	readonly method: string;
	readonly auth: RouteAuth;
	readonly side_effects: boolean;
}): ActionManifestEntry => ({
	method: spec.method,
	side_effects: spec.side_effects,
	account: spec.auth.account,
	actor: spec.auth.actor,
	roles: sorted_strings(spec.auth.roles),
	credential_types: sorted_strings(spec.auth.credential_types),
});

/** Deterministic byte-lexicographic method order — matches the Rust `str::cmp` the stub sorts by. */
const compare_method = (a: ActionManifestEntry, b: ActionManifestEntry): number =>
	a.method < b.method ? -1 : a.method > b.method ? 1 : 0;

/**
 * Build the normalized `ActionManifest` from a list of request-response
 * specs. Entries are sorted by `method` so two impls producing the same set
 * serialize identically regardless of mount order. The caller owns the scope
 * it passes (the TS spine passes its full mount; the Rust stub filters
 * `PROTOCOL_ACTION_SPECS` first) — see the module doc.
 */
export const build_action_manifest = (
	specs: ReadonlyArray<Pick<RequestResponseActionSpec, 'method' | 'auth' | 'side_effects'>>,
): ActionManifest => ({
	methods: specs.map(action_manifest_entry).sort(compare_method),
});
