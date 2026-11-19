import '../assert_dev_env.ts';

/**
 * Cross-impl RPC **action-manifest** introspection — a normalized,
 * JSON-serializable dump of a backend's live RPC method set, one entry per
 * method carrying its input shape, auth shape, side-effect flag, and
 * rate-limit class.
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
 * **Scope — domain + testing surface, not wire protocol.** Protocol actions
 * (`heartbeat` / `cancel` / `peer/ping`) are excluded: on the TS spine
 * `create_testing_action_manifest_action` filters them via the
 * `protocol_action_specs` method set; the Rust stub drops `PROTOCOL_ACTION_SPECS`. The
 * two impls organize protocol actions differently (`peer/ping` is on the TS
 * spine's WS **and** HTTP-RPC endpoints — it must answer `peer_no_transport`
 * over HTTP — while heartbeat/cancel stay WS-only; the Rust stub compiles one
 * shared registry serving both transports), so including them would be a
 * spurious cross-impl diff. This matches the scope of the in-repo
 * `spine_method_coverage` gate (also over `build_full_spine_rpc_actions`).
 *
 * **WebSocket-only domain methods are listed, with `transport: 'ws'`.** A
 * domain method a backend serves on its WebSocket endpoint alone (the room
 * verbs — the Rust stub's `ws_only` specs) is part of the surface both twins
 * must mount alike, so it stays in the manifest, and its entry says where it
 * is served. A method served on both transports carries no `transport` key,
 * so a mount with no WebSocket-only domain method dumps the same entries it
 * always has.
 *
 * Paired with `action_manifest_parity.ts` for the diff + assertion helpers.
 *
 * @module
 */

import {
	array,
	boolean,
	literal,
	nullable,
	object,
	one_of,
	optional,
	string,
	type Infer,
	type AnySchema
} from '@fuzdev/fuz_schema/schema.ts';

import { AuthAxisState, type RouteAuth } from '../../http/auth_shape.ts';
import { RateLimitKey } from '../../rate_limiter.ts';
import { is_void_schema } from '../../http/schema_helpers.ts';
import type { RequestResponseActionSpec } from '../../actions/action_spec.ts';

/**
 * One method's normalized RPC metadata — the cross-impl-comparable unit.
 * `roles` / `credential_types` are always present + sorted (an absent gate
 * and an empty list both serialize to `[]`) so the diff never trips on a
 * `undefined`-vs-`[]` or declaration-order difference between impls; the
 * auth axes reuse the canonical `AuthAxisState` enum. `rate_limit` is
 * nullable rather than optional for the same reason — an unthrottled action
 * serializes an explicit `null`, so a missing key is drift, not a default.
 */
export const ActionManifestEntry = object({
	/** RPC method name (`spec.method`). */
	method: string,
	/**
	 * `'void'` when the input is a void schema (`is_void_schema`: `s.void`, a
	 * parameterless method), else `'object'` — the Rust spine's declared
	 * `InputShape`, which its dispatcher enforces. An `object({})` input is
	 * `'object'`.
	 */
	input: one_of(['void', 'object']),
	/** `true` when the action declares `side_effects` (mutation; POST-only on the RPC transport). */
	side_effects: boolean,
	/** The `account` auth axis. */
	account: AuthAxisState,
	/** The `actor` auth axis. */
	actor: AuthAxisState,
	/** Required roles (any-of), sorted; `[]` when the action declares no role gate. */
	roles: array(string),
	/** Permitted credential channels, sorted; `[]` when ungated (any credential). */
	credential_types: array(string),
	/** Per-action rate-limit class, or `null` when the action declares none. */
	rate_limit: nullable(RateLimitKey),
	/**
	 * `'ws'` for a method served on the WebSocket transport only (the room
	 * verbs); absent for one served on both. Absent rather than `'both'` so a
	 * mount with no WebSocket-only method dumps exactly the keys it always has,
	 * on both spines (the Rust stub marks its `ws_only` specs the same way).
	 */
	transport: optional(literal('ws'))
});
export type ActionManifestEntry = Infer<typeof ActionManifestEntry>;

/** The full action manifest — every entry, sorted by `method`. */
export const ActionManifest = object({
	methods: array(ActionManifestEntry)
});
export type ActionManifest = Infer<typeof ActionManifest>;

/** Sorted copy of a readonly string list (stable cross-impl ordering). */
const sorted_strings = (xs: ReadonlyArray<string> | undefined): Array<string> =>
	[...(xs ?? [])].sort();

/** The spec fields a manifest entry reads. */
export type ActionManifestSpec = Pick<
	RequestResponseActionSpec,
	'method' | 'input' | 'auth' | 'side_effects' | 'rate_limit'
>;

/**
 * Normalize one spec's input shape + auth + side-effects into a manifest
 * entry. Reads the input shape off `is_void_schema(spec.input)`, pulls the
 * four auth axes off `RouteAuth` (the same shape the Rust `AuthSpec` mirrors),
 * and flattens optional `roles` / `credential_types` to sorted arrays.
 *
 * @param spec - the method's spec
 * @param ws_only - whether the method is served on the WebSocket transport
 *   only, which the entry says as `transport: 'ws'`
 */
export const action_manifest_entry = (
	spec: {
		readonly method: string;
		readonly input: AnySchema;
		readonly auth: RouteAuth;
		readonly side_effects: boolean;
		readonly rate_limit?: RateLimitKey;
	},
	ws_only = false
): ActionManifestEntry => ({
	method: spec.method,
	input: is_void_schema(spec.input) ? 'void' : 'object',
	side_effects: spec.side_effects,
	account: spec.auth.account,
	actor: spec.auth.actor,
	roles: sorted_strings(spec.auth.roles),
	credential_types: sorted_strings(spec.auth.credential_types),
	rate_limit: spec.rate_limit ?? null,
	...(ws_only && { transport: 'ws' as const })
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
 *
 * @param specs - the methods served on every transport the backend mounts
 * @param ws_only_specs - the methods served on its WebSocket endpoint only
 *   (`transport: 'ws'`), e.g. the room verbs
 */
export const build_action_manifest = (
	specs: ReadonlyArray<ActionManifestSpec>,
	ws_only_specs: ReadonlyArray<ActionManifestSpec> = []
): ActionManifest => ({
	methods: [
		...specs.map((spec) => action_manifest_entry(spec)),
		...ws_only_specs.map((spec) => action_manifest_entry(spec, true))
	].sort(compare_method)
});
