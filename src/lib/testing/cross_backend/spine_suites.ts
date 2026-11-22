import '../assert_dev_env.ts';

/**
 * One call that runs every shipped single-backend cross suite a backend's
 * capabilities admit — `describe_spine_cross_suites(handle, options)`.
 *
 * A consumer's cross project otherwise wires one file per upstream suite, so a
 * suite added here never reaches it unless someone adds the file. The one-call
 * form runs `SUITE_NAMES` — the closed registry of shipped suites, each named by
 * its module — and builds every suite's options from the handle: the paths,
 * cookie name and capabilities from `handle.config` (`to_cross_suite_options`),
 * the daemon token from the handle, and each suite's `setup_test` through
 * `default_cross_process_setup` with whatever seeding that suite needs (the
 * multi-actor keeper, the offer grantor, the cell role holder). Each suite
 * gates its own cases on the capabilities, so a backend runs what it mounts.
 *
 * **Options are additive.**
 *
 * - `exclude` names a suite with the reason it can't run on this backend; the
 *   reason is required and shows in the run as a skipped test, so a skip is
 *   stated in code and visible in the report. The suites in
 *   `UNEXCLUDABLE_SPINE_SUITES` can't be excluded, by suite or by case, and an
 *   override of one is held to an allowlist (`check_unexcludable_override`):
 *   `testing_backdoor` checks `capabilities.testing_backdoors`, which the
 *   backdoor gating reads, and takes only `extra_methods` and a dropped `ws`;
 *   `capability_mounts` checks the mount flags every suite gates on, takes
 *   nothing, and probes the paths the gated suites send to — the gated WS and
 *   readiness paths as `ws_role_gated` and `ready` run with them.
 * - `exclude_cases` names single tests of a suite that does run, each by its
 *   name path (describe titles and test name, joined with `' > '`) with a
 *   required reason; one `beforeEach` skips them at run time, so each shows as
 *   skipped with its reason, and an entry matching no collected test of its
 *   suite fails the closing check test.
 * - `expected_skips` declares the gated skips the backend owes — the cases a
 *   suite skips because the backend lacks what they gate on (`test_if`), and
 *   the suites skipped for an undeclared backdoor — each by its name path with
 *   a required reason. When given, a closing test (`check_declared_skips`)
 *   fails on a gated skip it doesn't list and on an entry whose test runs or
 *   that names no test, so a skip is never only a skipped line in the report.
 *   An `exclude` entry declares its suite's skip itself.
 * - `overrides` replaces a suite's derived options, field by field (a shallow
 *   merge over what the handle gives) — a role list the backend's WS upgrade
 *   requires, an `xfail` for a tracked divergence, a narrower capability set.
 *   An entry can be a function of the derived options instead, for a change
 *   built on a derived value. A required option the merge leaves `undefined`
 *   throws at collection.
 * - `rpc_success_fixtures` / `rpc_skip_methods` / `rpc_input_overrides` go to
 *   the standard bundle's RPC round-trip; `rpc_input_overrides` also seeds
 *   `rpc_adversarial`'s params cases (each override is the valid base they
 *   break one field of). A key naming a method on neither the declared surface
 *   nor `live_rpc_endpoints` throws at collection.
 * - `ws_required_roles` names the roles the backend's WS upgrade requires, so the
 *   suites that open sockets for accounts they create give them those roles.
 * - `suite_roles` names the roles the role-shaped suites use when the backend's
 *   registry lacks the spine's own (`cell_editor`, `participant`); the call
 *   seeds the holder each needs.
 *
 * **Inputs the handle doesn't carry.** The declared surface (`surface_source`,
 * `session_options`, `rpc_endpoints`, `roles`) is a required option. Paths and
 * roles that name what the reference spines mount (the role-gated WS endpoint
 * and its roles) default to the `SPINE_*` constants, and a suite whose
 * capability flag is off never reaches them. Anything else a suite needs comes
 * from the handle when it can (`session_cookie_codec`'s `cookie_keys` from the
 * config's `SECRET_FUZ_COOKIE_KEYS`), else from `overrides`; when neither has
 * it, the call throws naming the suite — provide it or exclude the suite.
 *
 * **Backdoors.** The backend's `capabilities.testing_backdoors` must declare
 * `SPINE_SUITES_REQUIRED_BACKDOORS` (the per-test reset and the audit
 * barrier), `_testing_db_invariants` (the per-test invariant check) unless
 * `setup.exclude_db_invariants` turns the check off with `all`,
 * `_testing_put_fact` when it declares `fact_serving`, and
 * `_testing_room_evict` when it declares `rooms`; the call throws otherwise. A
 * suite every case of which drives another backdoor (`credential_conformance`,
 * `credential_deadline`, `origin_conformance`, `ws_outbound_overflow`) skips
 * itself on a backend not
 * declaring it, shown like an exclude with a reason
 * naming the backdoor — so an exclude, override or `exclude_cases` entry for
 * it is refused as dead.
 *
 * **Not in the one call** (`STANDALONE_CROSS_SUITES`, with the reasons): the
 * suites that need two handles (the differential), a backend spawned with live
 * limiters (`login_security`, `ws_action_rate_limit` — the standard suites would
 * exhaust them), and the conformance runner, which runs the consumer's own
 * cases. Each keeps its own entry point.
 *
 * Suites are registered without a wrapping `describe`, so their test names are
 * the same as when each is called on its own — and an `exclude_cases` path is
 * the name the reporter prints after the file and any `describe` wrapping the
 * call.
 *
 * @module
 */

import {
	beforeAll,
	beforeEach,
	describe,
	test,
	TestRunner,
	type RunnerTask,
	type RunnerTestFile,
	type RunnerTestSuite
} from 'vitest';

import { ROLE_KEEPER, ROLE_ADMIN, type RoleRegistry } from '../../auth/role_schema.ts';
import type { SessionOptions } from '../../auth/session_cookie.ts';
import type { AppSurfaceSpec } from '../../http/surface.ts';
import { resolve_rpc_endpoints_for_setup, type RpcEndpointsSuiteOption } from '../rpc_helpers.ts';
import type { RpcSuccessFixtures } from '../rpc_round_trip.ts';
import {
	describe_account_lifecycle_cross_tests,
	type AccountLifecycleCrossTestOptions
} from './account_lifecycle.ts';
import {
	describe_actor_lookup_cross_tests,
	type ActorLookupCrossTestOptions
} from './actor_lookup.ts';
import {
	describe_app_settings_cross_tests,
	type AppSettingsCrossTestOptions
} from './app_settings.ts';
import { describe_body_size_cross_tests, type BodySizeCrossTestOptions } from './body_size.ts';
import {
	describe_body_size_smuggling_cross_tests,
	type BodySizeSmugglingCrossTestOptions
} from './body_size_smuggling.ts';
import type { BackendCapabilities } from './capabilities.ts';
import {
	assert_declared_skip_reasons,
	check_declared_skips,
	test_skip_gated
} from './declared_skips.ts';
import {
	describe_capability_mounts_cross_tests,
	resolve_capability_mounts_target,
	type CapabilityMountsCrossTestOptions
} from './capability_mounts.ts';
import { describe_cell_crud_cross_tests } from './cell_crud.ts';
import { describe_cell_gated_create_cross_tests } from './cell_gated_create.ts';
import {
	CELL_EDITOR_ROLE,
	CELL_ROLE_HOLDER_USERNAME,
	describe_cell_grant_role_cross_tests,
	type CellGrantRoleCrossTestOptions
} from './cell_grant_role.ts';
import { describe_cell_grant_steward_cross_tests } from './cell_grant_steward.ts';
import { describe_cell_moderate_cross_tests } from './cell_moderate.ts';
import { describe_cell_ref_admission_cross_tests } from './cell_ref_admission.ts';
import { describe_cell_relations_cross_tests } from './cell_relations.ts';
import {
	describe_cookie_attributes_cross_tests,
	type CookieAttributesCrossTestOptions
} from './cookie_attributes.ts';
import {
	describe_credential_deadline_cross_tests,
	type CredentialDeadlineCrossTestOptions
} from './credential_deadline.ts';
import {
	describe_credential_conformance_cross_tests,
	type CredentialConformanceCrossTestOptions
} from './credential_conformance.ts';
import {
	describe_credential_conformance_wire_cross_tests,
	type CredentialConformanceWireCrossTestOptions
} from './credential_conformance_wire.ts';
import { create_credential_wire_seed } from './credential_wire.ts';
import {
	describe_credential_header_robustness_cross_tests,
	type CredentialHeaderRobustnessCrossTestOptions
} from './credential_header_robustness.ts';
import {
	describe_fact_serving_cross_tests,
	type FactServingCrossTestOptions
} from './fact_serving.ts';
import {
	describe_identity_parity_cross_tests,
	type IdentityParityCrossTestOptions
} from './identity_parity.ts';
import { describe_origin_cross_tests, type OriginCrossTestOptions } from './origin.ts';
import {
	describe_origin_conformance_cross_tests,
	type OriginConformanceCrossTestOptions
} from './origin_conformance.ts';
import {
	describe_origin_scope_cross_tests,
	type OriginScopeCrossTestOptions
} from './origin_scope.ts';
import { describe_peer_ping_ws_tests, type PeerPingWsTestOptions } from './peer_ping_ws.ts';
import {
	describe_query_shape_cross_tests,
	type QueryShapeCrossTestOptions
} from './query_shape.ts';
import { describe_ready_cross_tests, type ReadyCrossTestOptions } from './ready.ts';
import {
	describe_request_header_conformance_wire_cross_tests,
	type RequestHeaderConformanceWireCrossTestOptions
} from './request_header_conformance_wire.ts';
import {
	describe_request_target_conformance_wire_cross_tests,
	type RequestTargetConformanceWireCrossTestOptions
} from './request_target_conformance_wire.ts';
import {
	describe_role_grant_offer_enumeration_cross_tests,
	OFFER_GRANTOR_USERNAME,
	type RoleGrantOfferEnumerationCrossTestOptions
} from './role_grant_offer_enumeration.ts';
import {
	describe_role_grant_offer_lifecycle_cross_tests,
	type RoleGrantOfferLifecycleCrossTestOptions
} from './role_grant_offer_lifecycle.ts';
import {
	describe_role_grant_offer_notification_ws_tests,
	type RoleGrantOfferNotificationWsTestOptions
} from './role_grant_offer_notification_ws.ts';
import {
	describe_role_grant_participation_cross_tests,
	type RoleGrantParticipationCrossTestOptions
} from './role_grant_participation.ts';
import {
	describe_role_grant_role_grammar_cross_tests,
	type RoleGrantRoleGrammarCrossTestOptions
} from './role_grant_role_grammar.ts';
import { describe_rooms_ws_cross_tests, type RoomsWsCrossTestOptions } from './rooms_ws.ts';
import {
	describe_rpc_adversarial_cross_tests,
	type RpcAdversarialCrossTestOptions
} from './rpc_adversarial.ts';
import {
	describe_session_cap_cross_tests,
	type SessionCapCrossTestOptions
} from './session_cap.ts';
import {
	describe_session_cookie_codec_cross_tests,
	type SessionCookieCodecCrossTestOptions
} from './session_cookie_codec.ts';
import {
	default_cross_process_setup,
	type CrossProcessSetupOptions,
	type ReconstructedBootstrappedBackendHandle,
	type RpcPathCapabilityGatedCrossSuiteOptions,
	type SetupTest
} from './setup.ts';
import {
	describe_simple_request_cross_tests,
	type SimpleRequestCrossTestOptions
} from './simple_request.ts';
import {
	SPINE_PARTICIPANT_ROLE,
	SPINE_ROLE_GATED_WS_PATH,
	SPINE_ROLE_GATED_WS_ROLES,
	type TestingBackdoorMethod
} from './spine_surface_constants.ts';
import {
	describe_cross_process_sse_tests,
	type CrossProcessSseTestOptions
} from './sse_round_trip.ts';
import {
	describe_standard_cross_process_tests,
	type StandardCrossProcessTestOptions
} from './standard.ts';
import {
	describe_testing_backdoor_cross_tests,
	type TestingBackdoorCrossTestOptions
} from './testing_backdoor.ts';
import {
	describe_token_lifetime_cross_tests,
	type TokenLifetimeCrossTestOptions
} from './token_lifetime.ts';
import {
	describe_token_scope_surface_cross_tests,
	type TokenScopeSurfaceCrossTestOptions
} from './token_scope_surface.ts';
import {
	describe_transport_composition_cross_tests,
	type TransportCompositionCrossTestOptions
} from './transport_composition.ts';
import {
	describe_ws_connection_cap_cross_tests,
	type WsConnectionCapCrossTestOptions
} from './ws_connection_cap.ts';
import {
	describe_ws_inbound_dispatch_cross_tests,
	type WsInboundDispatchCrossTestOptions
} from './ws_inbound_dispatch.ts';
import {
	describe_ws_envelope_cross_tests,
	type WsEnvelopeCrossTestOptions
} from './ws_envelope.ts';
import {
	describe_ws_outbound_overflow_cross_tests,
	type WsOutboundOverflowCrossTestOptions
} from './ws_outbound_overflow.ts';
import {
	describe_ws_role_gated_cross_tests,
	type WsRoleGatedCrossTestOptions
} from './ws_role_gated.ts';
import {
	describe_cross_process_ws_tests,
	type CrossProcessWsTestOptions
} from './ws_round_trip.ts';
import { DB_INVARIANTS_EXCLUDE_ALL, type DbInvariantExclusions } from '../db_invariant_queries.ts';

/**
 * Every shipped suite `describe_spine_cross_suites` runs, each named by its
 * module under `testing/cross_backend/` (`ws_round_trip` is
 * `describe_cross_process_ws_tests`, `standard` the standard bundle). Closed: a
 * guard test holds it, with `STANDALONE_CROSS_SUITES`, to every module that
 * exports a `describe_*` suite, so a new suite fails until it is registered.
 */
export const SUITE_NAMES = [
	'account_lifecycle',
	'actor_lookup',
	'app_settings',
	'body_size',
	'body_size_smuggling',
	'capability_mounts',
	'cell_crud',
	'cell_gated_create',
	'cell_grant_role',
	'cell_grant_steward',
	'cell_moderate',
	'cell_ref_admission',
	'cell_relations',
	'cookie_attributes',
	'credential_conformance',
	'credential_conformance_wire',
	'credential_deadline',
	'credential_header_robustness',
	'fact_serving',
	'identity_parity',
	'origin',
	'origin_conformance',
	'origin_scope',
	'peer_ping_ws',
	'query_shape',
	'ready',
	'request_header_conformance_wire',
	'request_target_conformance_wire',
	'role_grant_offer_enumeration',
	'role_grant_offer_lifecycle',
	'role_grant_offer_notification_ws',
	'role_grant_participation',
	'role_grant_role_grammar',
	'rooms_ws',
	'rpc_adversarial',
	'session_cap',
	'session_cookie_codec',
	'simple_request',
	'sse_round_trip',
	'standard',
	'testing_backdoor',
	'token_lifetime',
	'token_scope_surface',
	'transport_composition',
	'ws_connection_cap',
	'ws_envelope',
	'ws_inbound_dispatch',
	'ws_outbound_overflow',
	'ws_role_gated',
	'ws_round_trip'
] as const;

/** A shipped single-backend cross suite, named by its module. */
export type SuiteName = (typeof SUITE_NAMES)[number];

/** A shipped suite module `describe_spine_cross_suites` leaves out. */
export type StandaloneSuiteName =
	'conformance_table' | 'differential' | 'login_security' | 'ws_action_rate_limit';

/**
 * The shipped suite modules `describe_spine_cross_suites` leaves out, each with
 * why. Their entry points stay as they are; a consumer calls them beside the
 * one call.
 */
export const STANDALONE_CROSS_SUITES: Readonly<Record<StandaloneSuiteName, string>> = {
	differential:
		'compares two backends: it needs both handles of a dual-spawn project, not one backend',
	login_security:
		'needs a backend spawned with the login limiters enabled, which the standard suites would exhaust',
	ws_action_rate_limit:
		'needs a backend spawned with the action limiters enabled, which the standard suites would exhaust',
	conformance_table: "a runner over the consumer's own cases, not a suite"
};

/**
 * The backdoors `describe_spine_cross_suites` requires of every backend, since
 * the suites share them: `_testing_reset` is every `setup_test`'s per-test
 * reset, and `_testing_drain_effects` the barrier every audit read waits on. A
 * backend whose `capabilities.testing_backdoors` lacks one fails at collection.
 */
export const SPINE_SUITES_REQUIRED_BACKDOORS: ReadonlyArray<TestingBackdoorMethod> = Object.freeze([
	'_testing_reset',
	'_testing_drain_effects'
]);

/**
 * The suites `describe_spine_cross_suites` runs on every backend, each with
 * why: each checks declarations the other suites gate on, so neither `exclude`
 * nor `exclude_cases` can name it, and an override can't change the
 * declaration it reads.
 */
export const UNEXCLUDABLE_SPINE_SUITES: Readonly<Partial<Record<SuiteName, string>>> =
	Object.freeze({
		capability_mounts: 'it checks the capability flags the other suites gate on',
		testing_backdoor:
			'it checks the capabilities.testing_backdoors declaration the other suites gate on'
	});

/** A suite in `UNEXCLUDABLE_SPINE_SUITES`. */
type UnexcludableSuiteName = 'capability_mounts' | 'testing_backdoor';

/**
 * The override keys each unexcludable suite admits — an allowlist, so an
 * option added to the suite later is refused until it is classified here.
 * Any key passes with the value the handle derives; beyond that, `free` keys
 * take any value, `droppable` ones `undefined` too (dropping the cases they
 * turn on), and `fixed` ones nothing else (`capabilities` compared flag for
 * flag, a list as a multiset). Everything a
 * fixed key or an unlisted one could move is what the suite checks against.
 */
const UNEXCLUDABLE_OVERRIDE_KEYS: {
	readonly [K in UnexcludableSuiteName]: {
		readonly free: ReadonlyArray<keyof SuiteOptionsMap[K] & string>;
		readonly droppable: ReadonlyArray<keyof SuiteOptionsMap[K] & string>;
		readonly fixed: ReadonlyArray<keyof SuiteOptionsMap[K] & string>;
	};
} = {
	// every option is where the probes send or what they hold it to
	capability_mounts: {
		free: [],
		droppable: [],
		fixed: ['capabilities', 'rpc_path', 'base_url', 'ws_path', 'sse_path']
	},
	// a consumer's own seams, and dropping the socket cases — never moving
	// them, which would send them to an endpoint the declaration doesn't name
	testing_backdoor: {
		free: ['extra_methods'],
		droppable: ['ws'],
		fixed: ['capabilities', 'rpc_path']
	}
};

/** The options each suite takes, by `SuiteName` — what `overrides` entries are partials of. */
export interface SuiteOptionsMap {
	account_lifecycle: AccountLifecycleCrossTestOptions;
	actor_lookup: ActorLookupCrossTestOptions;
	app_settings: AppSettingsCrossTestOptions;
	body_size: BodySizeCrossTestOptions;
	body_size_smuggling: BodySizeSmugglingCrossTestOptions;
	capability_mounts: CapabilityMountsCrossTestOptions;
	cell_crud: RpcPathCapabilityGatedCrossSuiteOptions;
	cell_gated_create: RpcPathCapabilityGatedCrossSuiteOptions;
	cell_grant_role: CellGrantRoleCrossTestOptions;
	cell_grant_steward: RpcPathCapabilityGatedCrossSuiteOptions;
	cell_moderate: RpcPathCapabilityGatedCrossSuiteOptions;
	cell_ref_admission: RpcPathCapabilityGatedCrossSuiteOptions;
	cell_relations: RpcPathCapabilityGatedCrossSuiteOptions;
	cookie_attributes: CookieAttributesCrossTestOptions;
	credential_conformance: CredentialConformanceCrossTestOptions;
	credential_conformance_wire: CredentialConformanceWireCrossTestOptions;
	credential_deadline: CredentialDeadlineCrossTestOptions;
	credential_header_robustness: CredentialHeaderRobustnessCrossTestOptions;
	fact_serving: FactServingCrossTestOptions;
	identity_parity: IdentityParityCrossTestOptions;
	origin: OriginCrossTestOptions;
	origin_conformance: OriginConformanceCrossTestOptions;
	origin_scope: OriginScopeCrossTestOptions;
	peer_ping_ws: PeerPingWsTestOptions;
	query_shape: QueryShapeCrossTestOptions;
	ready: ReadyCrossTestOptions;
	request_header_conformance_wire: RequestHeaderConformanceWireCrossTestOptions;
	request_target_conformance_wire: RequestTargetConformanceWireCrossTestOptions;
	role_grant_offer_enumeration: RoleGrantOfferEnumerationCrossTestOptions;
	role_grant_offer_lifecycle: RoleGrantOfferLifecycleCrossTestOptions;
	role_grant_offer_notification_ws: RoleGrantOfferNotificationWsTestOptions;
	role_grant_participation: RoleGrantParticipationCrossTestOptions;
	role_grant_role_grammar: RoleGrantRoleGrammarCrossTestOptions;
	rooms_ws: RoomsWsCrossTestOptions;
	rpc_adversarial: RpcAdversarialCrossTestOptions;
	session_cap: SessionCapCrossTestOptions;
	session_cookie_codec: SessionCookieCodecCrossTestOptions;
	simple_request: SimpleRequestCrossTestOptions;
	sse_round_trip: CrossProcessSseTestOptions;
	standard: StandardCrossProcessTestOptions;
	testing_backdoor: TestingBackdoorCrossTestOptions;
	token_lifetime: TokenLifetimeCrossTestOptions;
	token_scope_surface: TokenScopeSurfaceCrossTestOptions;
	transport_composition: TransportCompositionCrossTestOptions;
	ws_connection_cap: WsConnectionCapCrossTestOptions;
	ws_envelope: WsEnvelopeCrossTestOptions;
	ws_inbound_dispatch: WsInboundDispatchCrossTestOptions;
	ws_outbound_overflow: WsOutboundOverflowCrossTestOptions;
	ws_role_gated: WsRoleGatedCrossTestOptions;
	ws_round_trip: CrossProcessWsTestOptions;
}

/**
 * One suite's override: options shallow-merged over the ones the handle gives,
 * or a function of those derived options returning them — for a change that
 * builds on a derived value (a seeded `setup_test`, the capabilities) rather
 * than restating it.
 */
export type SuiteOverride<K extends SuiteName> =
	Partial<SuiteOptionsMap[K]> | ((derived: SuiteOptionsMap[K]) => Partial<SuiteOptionsMap[K]>);

/** Per-suite option overrides, each merged over the options the handle gives. */
export type SuiteOverrides = { readonly [K in SuiteName]?: SuiteOverride<K> };

/**
 * Per-suite test exclusions: each test's name path — its describe titles and
 * its own name, joined with `' > '`, as the reporter prints it after the file
 * (and after any `describe` wrapping the call) — mapped to why it can't run on
 * this backend.
 */
export type SuiteCaseExclusions = Readonly<
	Partial<Record<SuiteName, Readonly<Record<string, string>>>>
>;

/** The keys `T` requires — the ones an override must not leave `undefined`. */
type RequiredKeys<T> = {
	[P in keyof T]-?: T extends Record<P, T[P]> ? P : never;
}[keyof T];

/** Every key `T` requires, as a set — exhaustive by its type. */
type RequiredKeySet<T> = Readonly<Record<RequiredKeys<T>, true>>;

/** The suite options a backend's `BackendConfig` supplies. */
export interface CrossSuiteHandleOptions {
	readonly capabilities: BackendCapabilities;
	readonly base_url: string;
	readonly rpc_path: string;
	readonly ws_path: string;
	readonly sse_path: string | undefined;
	readonly cookie_name: string;
}

/**
 * The suite options a handle's `config` supplies — the fields most cross
 * suites take beside `setup_test`. For a suite called on its own:
 * `describe_ready_cross_tests({setup_test, ...to_cross_suite_options(handle)})`
 * passes extra fields the suite's type doesn't list, so destructure what it
 * takes instead when calling it with an object literal.
 */
export const to_cross_suite_options = (
	handle: Pick<ReconstructedBootstrappedBackendHandle, 'config'>
): CrossSuiteHandleOptions => {
	const { capabilities, base_url, rpc_path, ws_path, sse_path, cookie_name } = handle.config;
	return { capabilities, base_url, rpc_path, ws_path, sse_path, cookie_name };
};

/**
 * The roles the role-shaped suites use, for a backend whose registry lacks
 * the spine's own. Set them here rather than in `overrides`: the call seeds
 * the holder each needs.
 */
export interface SpineSuiteRoles {
	/**
	 * The role `cell_grant_role`'s grants name, seeded on its holder at reset.
	 * Default `SPINE_CELL_EDITOR_ROLE`. `ROLE_KEEPER` serves a backend with only
	 * the builtin roles; `ROLE_ADMIN` can't (an admin reaches every cell).
	 */
	readonly cell_grant?: string;
	/**
	 * The admin-grantable role `role_grant_offer_lifecycle` offers,
	 * `role_grant_participation` confers, and `role_grant_offer_notification_ws`
	 * assigns in a scope and revokes. Default `SPINE_PARTICIPANT_ROLE`;
	 * `ROLE_ADMIN` serves a backend with only the builtin roles (the scoped
	 * assign and scoped revoke cases then skip, as a builtin is global-only).
	 */
	readonly conferral?: string;
}

/** Options for `describe_spine_cross_suites`. */
export interface SpineCrossSuitesOptions {
	/** The declared surface — the standard bundle and `rpc_adversarial` enumerate it. */
	readonly surface_source: AppSurfaceSpec;
	/** The backend's session config, for the standard bundle. */
	readonly session_options: SessionOptions<string>;
	/** The backend's RPC endpoints, for the standard bundle. */
	readonly rpc_endpoints: RpcEndpointsSuiteOption;
	/**
	 * The RPC endpoints the backend live-mounts, for the methods it keeps off
	 * the declared surface (cell verbs, opt-in resolvers, `_testing_*`
	 * backdoors); given, `rpc_adversarial` sends them bad envelopes and params
	 * too. A backend's whole live mount is a fine value — a declared method
	 * still runs once, from the declared surface.
	 */
	readonly live_rpc_endpoints?: RpcEndpointsSuiteOption;
	/** The backend's role registry; given, the standard bundle runs its admin suite. */
	readonly roles?: RoleRegistry;
	/**
	 * Setup options every suite's `setup_test` starts from — a signup path the
	 * backend mounts elsewhere, `reject_unknown_audit_metadata_keys` for a
	 * backend's own spine suite. A suite's own seeding is added to it (the role,
	 * account and actor lists concatenate).
	 */
	readonly setup?: CrossProcessSetupOptions;
	/**
	 * Suites this backend doesn't run, each with a non-empty reason. Each shows
	 * in the run as one skipped test carrying the reason. Not a suite in
	 * `UNEXCLUDABLE_SPINE_SUITES`, nor one that already skips itself for an
	 * undeclared backdoor.
	 */
	readonly exclude?: Readonly<Partial<Record<SuiteName, string>>>;
	/**
	 * Single tests this backend doesn't run, by suite, each by its name path
	 * (`SuiteCaseExclusions`) with a non-empty reason; each shows in the run as
	 * skipped with its reason. An entry naming a suite the call doesn't run, a
	 * suite in `UNEXCLUDABLE_SPINE_SUITES`, or a path no collected test of that
	 * suite has, fails.
	 */
	readonly exclude_cases?: SuiteCaseExclusions;
	/**
	 * The gated skips this backend owes — each test a suite registers skipped
	 * because the backend lacks what it gates on (`test_if`, a suite skipped
	 * for an undeclared backdoor), by its name path below the calling suite,
	 * with a non-empty reason. When given, a closing test
	 * (`check_declared_skips`) fails on a gated skip not listed here, and on
	 * an entry whose test runs or that names no test. An `exclude`d suite's
	 * skip is declared by its `exclude` entry. Omitted, no skip is checked.
	 */
	readonly expected_skips?: Readonly<Record<string, string>>;
	/** Per-suite option overrides, a shallow merge over what the handle gives. */
	readonly overrides?: SuiteOverrides;
	/** The roles the role-shaped suites use, when the backend lacks the spine's own. */
	readonly suite_roles?: SpineSuiteRoles;
	/**
	 * The roles the backend's WS upgrade on `ws_path` requires (an admin-gated
	 * `/api/ws`: `[ROLE_ADMIN]`). Given, the suites that open sockets for
	 * accounts they create — `credential_deadline`, `session_cap`,
	 * `ws_round_trip` — create them holding these (`ws_account_roles`), and
	 * `role_grant_offer_notification_ws` expects revoking one to close the
	 * socket (`ws_required_roles`). Each must be admin-grantable.
	 */
	readonly ws_required_roles?: ReadonlyArray<string>;
	/**
	 * The backend's request-body cap on `rpc_path`, in bytes, when it isn't the
	 * spine default (`SPINE_BODY_LIMIT_DEFAULT_BYTES`): the boundary
	 * `body_size`, `body_size_smuggling`, `transport_composition`'s RPC
	 * over-cap row and the standard bundle's body-limit probe of the RPC
	 * endpoint probe.
	 */
	readonly rpc_max_body_bytes?: number;
	/**
	 * The backend's inbound WebSocket message cap on `ws_path`, in bytes, when
	 * it isn't the spine default (`DEFAULT_WS_MAX_MESSAGE_BYTES`): the boundary
	 * `ws_round_trip`'s oversized-message case sends past.
	 */
	readonly ws_max_message_bytes?: number;
	/** Forwarded to the standard bundle (`StandardCrossProcessTestOptions.rpc_success_fixtures`). */
	readonly rpc_success_fixtures?: RpcSuccessFixtures;
	/** Forwarded to the standard bundle (`StandardCrossProcessTestOptions.rpc_skip_methods`). */
	readonly rpc_skip_methods?: Array<string>;
	/**
	 * Forwarded to the standard bundle (`StandardCrossProcessTestOptions.rpc_input_overrides`)
	 * and to `rpc_adversarial` (`RpcAdversarialCrossTestOptions.input_overrides`),
	 * where each override seeds the method's params cases. Those cases are sent
	 * as a single-actor principal, so an override omits `acting`. A key naming a
	 * method on neither the declared surface nor `live_rpc_endpoints` throws at
	 * collection.
	 */
	readonly rpc_input_overrides?: Map<string, Record<string, unknown>>;
}

/** What a suite's entry builds its options from. */
interface SuiteContext {
	readonly handle: ReconstructedBootstrappedBackendHandle;
	readonly config: CrossSuiteHandleOptions;
	readonly options: SpineCrossSuitesOptions;
	/** A `setup_test` from the base setup options plus this suite's seeding. */
	readonly setup: (seed?: CrossProcessSetupOptions) => SetupTest;
	/**
	 * The registration's setup wrapper, applied after the override merge to
	 * every slot a derived setup filled (`derived_setups`, what `setup`
	 * returned) — so a setup an override puts there is wrapped too.
	 */
	readonly wrap_setup_test: {
		readonly wrap: (setup_test: SetupTest) => SetupTest;
		readonly derived_setups: WeakSet<SetupTest>;
	} | null;
	/** `{base_url, ws_path}` when the backend mounts WS, for suites whose socket cases are optional. */
	readonly ws: { readonly base_url: string; readonly ws_path: string } | undefined;
	/**
	 * A suite's options, derived and merged with its override — computed once
	 * per suite, so a suite reading a sibling's (the mount suite reads the
	 * paths the gated suites send to) sees what that sibling runs with.
	 */
	readonly merged: <K extends SuiteName>(name: K) => SuiteOptionsMap[K];
}

interface SuiteEntry<K extends SuiteName> {
	readonly derive: (context: SuiteContext) => SuiteOptionsMap[K];
	readonly describe: (options: SuiteOptionsMap[K]) => void;
	/**
	 * The suite's required options, checked after the override merge: none may be
	 * `undefined` or an empty string — an override that clears one, or an input the
	 * handle doesn't carry (`cookie_keys`), fails at collection.
	 */
	readonly required: RequiredKeySet<SuiteOptionsMap[K]>;
	/**
	 * The backdoors every case of the suite drives, beyond
	 * `SPINE_SUITES_REQUIRED_BACKDOORS`; a backend not declaring one skips the
	 * whole suite, with a reason naming it.
	 */
	readonly backdoors?: ReadonlyArray<TestingBackdoorMethod>;
	/** Whether fuz_app's transcript differential runs the suite (`SpineSuiteTranscript`). */
	readonly transcript: SpineSuiteTranscript;
}

/**
 * Whether fuz_app's transcript differential — the suites run once per backend,
 * every request and answer recorded and compared — runs a suite: `'http'`
 * when every request it sends goes through the fixture transports the
 * transcript records, else excluded with why.
 *
 * @internal Read by fuz_app's transcript differential — not stable API.
 */
export type SpineSuiteTranscript = 'http' | { readonly excluded: string };

const TRANSCRIPT_WEBSOCKET: SpineSuiteTranscript = {
	excluded: 'opens WebSockets, whose frames the transcript does not record'
};
const TRANSCRIPT_RAW_SOCKET: SpineSuiteTranscript = {
	excluded: 'sends on raw sockets, outside the fixture transports the transcript records'
};
const TRANSCRIPT_SSE: SpineSuiteTranscript = {
	excluded: 'reads the audit event stream, which the transcript records unread'
};
const TRANSCRIPT_UNTRIAGED: SpineSuiteTranscript = {
	excluded: 'HTTP only, but not yet run under the transcript with its differences triaged'
};

/**
 * The roles of `ws_required_roles` the keeper must be seeded with so its
 * session can open a socket — the builtins it already holds left out.
 */
const to_keeper_ws_roles = (c: SuiteContext): Array<string> =>
	(c.options.ws_required_roles ?? []).filter((role) => role !== ROLE_KEEPER && role !== ROLE_ADMIN);

/**
 * The path each mount probe reads from a sibling suite — the suite gated on
 * the flag, whose option names where the surface is mounted.
 */
const MOUNT_PROBE_SIBLING_PATHS = [
	{ flag: 'ws_role_gated', suite: 'ws_role_gated', option: 'gated_ws_path' },
	{ flag: 'ready', suite: 'ready', option: 'ready_path' }
] as const;

/**
 * The suites whose `exclude` and `overrides` entries a suite reads beside its
 * own — the mount suite reads each probe's sibling — so a registration
 * running the reader without them still reads those entries.
 */
const SIBLING_READS: Readonly<Partial<Record<SuiteName, ReadonlyArray<SuiteName>>>> = {
	capability_mounts: MOUNT_PROBE_SIBLING_PATHS.map(({ suite }) => suite)
};

/**
 * A note for each mount probe whose sibling suite the call excludes: the probe
 * falls back to the spine default, and the remedy is the sibling's override.
 */
const to_sibling_path_notes = (
	c: SuiteContext
): Partial<Record<(typeof MOUNT_PROBE_SIBLING_PATHS)[number]['flag'], string>> => {
	const notes: Partial<Record<(typeof MOUNT_PROBE_SIBLING_PATHS)[number]['flag'], string>> = {};
	for (const { flag, suite, option } of MOUNT_PROBE_SIBLING_PATHS) {
		if (c.options.exclude?.[suite] === undefined) continue;
		notes[flag] =
			`'${suite}' is excluded, so this probe sends to the spine default; to probe the ` +
			`backend's own path, un-exclude '${suite}' and set it there with \`overrides.${suite}.${option}\``;
	}
	return notes;
};

/** The capability-gated RPC-path shape the cell suites and several others share. */
const rpc_gated = (c: SuiteContext, seed?: CrossProcessSetupOptions) => ({
	setup_test: c.setup(seed),
	capabilities: c.config.capabilities,
	rpc_path: c.config.rpc_path
});

const SUITE_ENTRIES: { readonly [K in SuiteName]: SuiteEntry<K> } = {
	account_lifecycle: {
		derive: (c) => rpc_gated(c),
		describe: describe_account_lifecycle_cross_tests,
		transcript: 'http',
		required: { setup_test: true, capabilities: true }
	},
	actor_lookup: {
		derive: (c) => ({ setup_test: c.setup(), rpc_path: c.config.rpc_path }),
		describe: describe_actor_lookup_cross_tests,
		transcript: TRANSCRIPT_UNTRIAGED,
		required: { setup_test: true }
	},
	app_settings: {
		derive: (c) => ({ setup_test: c.setup(), rpc_path: c.config.rpc_path }),
		describe: describe_app_settings_cross_tests,
		transcript: TRANSCRIPT_UNTRIAGED,
		required: { setup_test: true }
	},
	body_size: {
		derive: (c) => ({
			setup_test: c.setup(),
			rpc_path: c.config.rpc_path,
			base_url: c.config.base_url,
			rpc_max_body_bytes: c.options.rpc_max_body_bytes
		}),
		describe: describe_body_size_cross_tests,
		transcript: TRANSCRIPT_RAW_SOCKET,
		required: { setup_test: true, base_url: true }
	},
	body_size_smuggling: {
		derive: (c) => ({
			base_url: c.config.base_url,
			rpc_path: c.config.rpc_path,
			rpc_max_body_bytes: c.options.rpc_max_body_bytes
		}),
		describe: describe_body_size_smuggling_cross_tests,
		transcript: TRANSCRIPT_RAW_SOCKET,
		required: { base_url: true }
	},
	capability_mounts: {
		// the keeper holds the upgrade's roles, so its session can open the
		// socket the account-actions probe sends on; each path is the one the
		// suites gated on its flag send to — the config's, and the gated WS and
		// readiness paths of `ws_role_gated` and `ready` as they run (their
		// defaults when excluded)
		derive: (c) => ({
			setup_test: c.setup({ extra_keeper_roles: to_keeper_ws_roles(c) }),
			capabilities: c.config.capabilities,
			...resolve_capability_mounts_target({
				base_url: c.config.base_url,
				rpc_path: c.config.rpc_path,
				ws_path: c.config.ws_path,
				sse_path: c.config.sse_path,
				gated_ws_path:
					c.options.exclude?.ws_role_gated === undefined
						? c.merged('ws_role_gated').gated_ws_path
						: undefined,
				ready_path:
					c.options.exclude?.ready === undefined ? c.merged('ready').ready_path : undefined
			}),
			path_notes: to_sibling_path_notes(c)
		}),
		describe: describe_capability_mounts_cross_tests,
		transcript: TRANSCRIPT_WEBSOCKET,
		required: { setup_test: true, capabilities: true, base_url: true }
	},
	cell_crud: {
		derive: (c) => rpc_gated(c),
		describe: describe_cell_crud_cross_tests,
		transcript: TRANSCRIPT_UNTRIAGED,
		required: { setup_test: true, capabilities: true }
	},
	cell_gated_create: {
		derive: (c) => rpc_gated(c),
		describe: describe_cell_gated_create_cross_tests,
		transcript: TRANSCRIPT_UNTRIAGED,
		required: { setup_test: true, capabilities: true }
	},
	cell_grant_role: {
		// the holder is seeded at reset: `CELL_EDITOR_ROLE` has no grant path
		derive: (c) => {
			const role = c.options.suite_roles?.cell_grant ?? CELL_EDITOR_ROLE;
			return {
				...rpc_gated(c, {
					extra_accounts: [{ username: CELL_ROLE_HOLDER_USERNAME, roles: [role] }]
				}),
				role
			};
		},
		describe: describe_cell_grant_role_cross_tests,
		transcript: TRANSCRIPT_UNTRIAGED,
		required: { setup_test: true, capabilities: true }
	},
	cell_grant_steward: {
		derive: (c) => rpc_gated(c),
		describe: describe_cell_grant_steward_cross_tests,
		transcript: TRANSCRIPT_UNTRIAGED,
		required: { setup_test: true, capabilities: true }
	},
	cell_moderate: {
		derive: (c) => rpc_gated(c),
		describe: describe_cell_moderate_cross_tests,
		transcript: TRANSCRIPT_UNTRIAGED,
		required: { setup_test: true, capabilities: true }
	},
	cell_ref_admission: {
		derive: (c) => rpc_gated(c),
		describe: describe_cell_ref_admission_cross_tests,
		transcript: TRANSCRIPT_UNTRIAGED,
		required: { setup_test: true, capabilities: true }
	},
	cell_relations: {
		derive: (c) => rpc_gated(c),
		describe: describe_cell_relations_cross_tests,
		transcript: TRANSCRIPT_UNTRIAGED,
		required: { setup_test: true, capabilities: true }
	},
	cookie_attributes: {
		derive: (c) => ({ setup_test: c.setup(), cookie_name: c.config.cookie_name }),
		describe: describe_cookie_attributes_cross_tests,
		transcript: 'http',
		required: { setup_test: true, cookie_name: true }
	},
	credential_deadline: {
		derive: (c) => ({
			setup_test: c.setup(),
			capabilities: c.config.capabilities,
			base_url: c.config.base_url,
			ws_path: c.config.ws_path,
			sse_path: c.config.sse_path,
			rpc_path: c.config.rpc_path,
			ws_account_roles: c.options.ws_required_roles
		}),
		describe: describe_credential_deadline_cross_tests,
		transcript: TRANSCRIPT_WEBSOCKET,
		required: { setup_test: true, capabilities: true, base_url: true, ws_path: true },
		backdoors: ['_testing_shorten_credential_expiry']
	},
	credential_conformance: {
		derive: (c) => ({
			setup_test: c.setup(),
			cookie_name: c.config.cookie_name,
			cookie_keys: c.handle.config.env.SECRET_FUZ_COOKIE_KEYS ?? '',
			daemon_token: c.handle.daemon_token,
			rpc_path: c.config.rpc_path
		}),
		describe: describe_credential_conformance_cross_tests,
		transcript: TRANSCRIPT_UNTRIAGED,
		required: { setup_test: true, cookie_name: true, cookie_keys: true, daemon_token: true },
		backdoors: ['_testing_credential_read']
	},
	credential_conformance_wire: {
		// the session and the API token on accounts of their own, so the account
		// a request authenticates as says which credential did; `ws_required_roles`
		// lets each of them, and the keeper behind the daemon token, open a
		// socket where the upgrade is role-gated
		derive: (c) => ({
			setup_test: c.setup(create_credential_wire_seed(c.options.ws_required_roles)),
			capabilities: c.config.capabilities,
			base_url: c.config.base_url,
			cookie_name: c.config.cookie_name,
			cookie_keys: c.handle.config.env.SECRET_FUZ_COOKIE_KEYS ?? '',
			daemon_token: c.handle.daemon_token,
			rpc_path: c.config.rpc_path,
			ws_path: c.config.ws_path
		}),
		describe: describe_credential_conformance_wire_cross_tests,
		transcript: TRANSCRIPT_RAW_SOCKET,
		required: {
			setup_test: true,
			capabilities: true,
			base_url: true,
			cookie_name: true,
			cookie_keys: true,
			daemon_token: true
		}
	},
	credential_header_robustness: {
		derive: (c) => ({
			base_url: c.config.base_url,
			rpc_path: c.config.rpc_path
		}),
		describe: describe_credential_header_robustness_cross_tests,
		transcript: TRANSCRIPT_RAW_SOCKET,
		required: { base_url: true }
	},
	fact_serving: {
		// the multi-actor setup reaches the fallthrough a single-actor keeper can't
		derive: (c) => ({
			...rpc_gated(c),
			setup_test_multi_actor: c.setup({ extra_actors: ['second_persona'] })
		}),
		describe: describe_fact_serving_cross_tests,
		transcript: TRANSCRIPT_UNTRIAGED,
		required: { setup_test: true, capabilities: true }
	},
	identity_parity: {
		derive: (c) => ({ setup_test: c.setup() }),
		describe: describe_identity_parity_cross_tests,
		transcript: 'http',
		required: { setup_test: true }
	},
	origin: {
		derive: (c) => ({ setup_test: c.setup(), rpc_path: c.config.rpc_path }),
		describe: describe_origin_cross_tests,
		transcript: TRANSCRIPT_UNTRIAGED,
		required: { setup_test: true }
	},
	origin_conformance: {
		derive: (c) => ({ setup_test: c.setup(), rpc_path: c.config.rpc_path }),
		describe: describe_origin_conformance_cross_tests,
		transcript: TRANSCRIPT_UNTRIAGED,
		required: { setup_test: true },
		backdoors: ['_testing_origin_check']
	},
	origin_scope: {
		derive: (c) => ({
			setup_test: c.setup(),
			capabilities: c.config.capabilities,
			base_url: c.config.base_url
		}),
		describe: describe_origin_scope_cross_tests,
		transcript: TRANSCRIPT_RAW_SOCKET,
		required: { setup_test: true, capabilities: true }
	},
	peer_ping_ws: {
		derive: (c) => ({
			setup_test: c.setup(),
			capabilities: c.config.capabilities,
			base_url: c.config.base_url,
			ws_path: c.config.ws_path
		}),
		describe: describe_peer_ping_ws_tests,
		transcript: TRANSCRIPT_WEBSOCKET,
		required: { setup_test: true, capabilities: true, base_url: true, ws_path: true }
	},
	query_shape: {
		derive: (c) => rpc_gated(c),
		describe: describe_query_shape_cross_tests,
		transcript: TRANSCRIPT_UNTRIAGED,
		required: { setup_test: true, capabilities: true }
	},
	ready: {
		derive: (c) => ({ setup_test: c.setup(), capabilities: c.config.capabilities }),
		describe: describe_ready_cross_tests,
		transcript: TRANSCRIPT_UNTRIAGED,
		required: { setup_test: true, capabilities: true }
	},
	request_header_conformance_wire: {
		// the credential accounts, so the account a request authenticates as
		// says which credential did
		derive: (c) => ({
			setup_test: c.setup(create_credential_wire_seed(c.options.ws_required_roles)),
			capabilities: c.config.capabilities,
			base_url: c.config.base_url,
			cookie_name: c.config.cookie_name,
			daemon_token: c.handle.daemon_token,
			rpc_path: c.config.rpc_path,
			ws_path: c.config.ws_path
		}),
		describe: describe_request_header_conformance_wire_cross_tests,
		transcript: TRANSCRIPT_RAW_SOCKET,
		required: {
			setup_test: true,
			capabilities: true,
			base_url: true,
			cookie_name: true,
			daemon_token: true
		}
	},
	request_target_conformance_wire: {
		// the keeper holds the upgrade's roles, so its session can open a socket
		// (it already holds the builtin ones)
		derive: (c) => ({
			setup_test: c.setup({
				extra_keeper_roles: to_keeper_ws_roles(c)
			}),
			capabilities: c.config.capabilities,
			base_url: c.config.base_url,
			rpc_path: c.config.rpc_path,
			ws_path: c.config.ws_path,
			sse_path: c.config.sse_path
		}),
		describe: describe_request_target_conformance_wire_cross_tests,
		transcript: TRANSCRIPT_RAW_SOCKET,
		required: { setup_test: true, capabilities: true, base_url: true }
	},
	role_grant_offer_enumeration: {
		// a sibling actor for the wrong-persona arm, and a single-actor admin
		// grantor (the keeper can't offer to itself)
		derive: (c) => ({
			setup_test: c.setup({
				extra_actors: ['offer_sibling'],
				extra_accounts: [{ username: OFFER_GRANTOR_USERNAME, roles: [ROLE_ADMIN] }]
			}),
			rpc_path: c.config.rpc_path
		}),
		describe: describe_role_grant_offer_enumeration_cross_tests,
		transcript: TRANSCRIPT_UNTRIAGED,
		required: { setup_test: true }
	},
	role_grant_offer_lifecycle: {
		derive: (c) => ({
			setup_test: c.setup(),
			rpc_path: c.config.rpc_path,
			role: c.options.suite_roles?.conferral
		}),
		describe: describe_role_grant_offer_lifecycle_cross_tests,
		transcript: 'http',
		required: { setup_test: true }
	},
	role_grant_offer_notification_ws: {
		derive: (c) => ({
			setup_test: c.setup(),
			capabilities: c.config.capabilities,
			base_url: c.config.base_url,
			ws_path: c.config.ws_path,
			ws_required_roles: c.options.ws_required_roles,
			scoped_role: c.options.suite_roles?.conferral
		}),
		describe: describe_role_grant_offer_notification_ws_tests,
		transcript: TRANSCRIPT_WEBSOCKET,
		required: { setup_test: true, capabilities: true, base_url: true, ws_path: true }
	},
	role_grant_participation: {
		derive: (c) => ({
			setup_test: c.setup(),
			rpc_path: c.config.rpc_path,
			role: c.options.suite_roles?.conferral
		}),
		describe: describe_role_grant_participation_cross_tests,
		transcript: TRANSCRIPT_UNTRIAGED,
		required: { setup_test: true }
	},
	role_grant_role_grammar: {
		derive: (c) => ({ setup_test: c.setup(), rpc_path: c.config.rpc_path }),
		describe: describe_role_grant_role_grammar_cross_tests,
		transcript: TRANSCRIPT_UNTRIAGED,
		required: { setup_test: true }
	},
	rooms_ws: {
		derive: (c) => ({
			setup_test: c.setup(),
			capabilities: c.config.capabilities,
			base_url: c.config.base_url,
			ws_path: c.config.ws_path,
			rpc_path: c.config.rpc_path
		}),
		describe: describe_rooms_ws_cross_tests,
		transcript: TRANSCRIPT_WEBSOCKET,
		required: { setup_test: true, capabilities: true, base_url: true, ws_path: true }
	},
	rpc_adversarial: {
		derive: (c) => ({
			setup_test: c.setup(),
			surface_source: c.options.surface_source,
			live_rpc_endpoints:
				c.options.live_rpc_endpoints &&
				resolve_rpc_endpoints_for_setup(c.options.live_rpc_endpoints, c.options.session_options),
			rpc_path: c.config.rpc_path,
			input_overrides: c.options.rpc_input_overrides
		}),
		describe: describe_rpc_adversarial_cross_tests,
		transcript: TRANSCRIPT_UNTRIAGED,
		required: { setup_test: true, surface_source: true }
	},
	session_cap: {
		derive: (c) => ({
			setup_test: c.setup(),
			rpc_path: c.config.rpc_path,
			ws: c.ws,
			ws_account_actions: c.config.capabilities.ws_account_actions,
			ws_account_roles: c.options.ws_required_roles
		}),
		describe: describe_session_cap_cross_tests,
		transcript: TRANSCRIPT_WEBSOCKET,
		required: { setup_test: true }
	},
	session_cookie_codec: {
		derive: (c) => ({
			setup_test: c.setup(),
			cookie_name: c.config.cookie_name,
			cookie_keys: c.handle.config.env.SECRET_FUZ_COOKIE_KEYS ?? '',
			rpc_path: c.config.rpc_path
		}),
		describe: describe_session_cookie_codec_cross_tests,
		transcript: TRANSCRIPT_UNTRIAGED,
		required: { setup_test: true, cookie_name: true, cookie_keys: true }
	},
	simple_request: {
		derive: (c) => ({ setup_test: c.setup(), rpc_path: c.config.rpc_path }),
		describe: describe_simple_request_cross_tests,
		transcript: TRANSCRIPT_UNTRIAGED,
		required: { setup_test: true }
	},
	sse_round_trip: {
		derive: (c) => ({
			setup_test: c.setup(),
			capabilities: c.config.capabilities,
			base_url: c.config.base_url,
			sse_path: c.config.sse_path,
			rpc_path: c.config.rpc_path
		}),
		describe: describe_cross_process_sse_tests,
		transcript: TRANSCRIPT_SSE,
		required: { setup_test: true, capabilities: true, base_url: true }
	},
	standard: {
		// a keeper-only account for the admin suite's keeper ≠ admin probe —
		// `ROLE_KEEPER` is bootstrap-only, so it is seeded at reset
		derive: (c) => ({
			setup_test: c.setup({
				extra_accounts: [{ username: 'non_admin_keeper', roles: [ROLE_KEEPER] }]
			}),
			surface_source: c.options.surface_source,
			capabilities: c.config.capabilities,
			session_options: c.options.session_options,
			rpc_endpoints: c.options.rpc_endpoints,
			roles: c.options.roles,
			rpc_success_fixtures: c.options.rpc_success_fixtures,
			rpc_skip_methods: c.options.rpc_skip_methods,
			rpc_input_overrides: c.options.rpc_input_overrides,
			base_url: c.config.base_url,
			rpc_max_body_bytes: c.options.rpc_max_body_bytes
		}),
		describe: describe_standard_cross_process_tests,
		transcript: TRANSCRIPT_UNTRIAGED,
		required: {
			setup_test: true,
			surface_source: true,
			session_options: true,
			rpc_endpoints: true,
			capabilities: true,
			base_url: true
		}
	},
	testing_backdoor: {
		derive: (c) => ({ ...rpc_gated(c), ws: c.ws }),
		describe: describe_testing_backdoor_cross_tests,
		transcript: TRANSCRIPT_WEBSOCKET,
		required: { setup_test: true, capabilities: true }
	},
	token_lifetime: {
		derive: (c) => ({ setup_test: c.setup(), rpc_path: c.config.rpc_path }),
		describe: describe_token_lifetime_cross_tests,
		transcript: TRANSCRIPT_UNTRIAGED,
		required: { setup_test: true }
	},
	token_scope_surface: {
		derive: (c) => ({ ...rpc_gated(c), sse_path: c.config.sse_path }),
		describe: describe_token_scope_surface_cross_tests,
		transcript: TRANSCRIPT_UNTRIAGED,
		required: { setup_test: true, capabilities: true }
	},
	transport_composition: {
		derive: (c) => ({
			...rpc_gated(c),
			base_url: c.config.base_url,
			ws_path: c.config.ws_path,
			sse_path: c.config.sse_path,
			multi_actor: { setup_test: c.setup({ extra_actors: ['keeper_second_persona'] }) },
			rpc_max_body_bytes: c.options.rpc_max_body_bytes
		}),
		describe: describe_transport_composition_cross_tests,
		transcript: TRANSCRIPT_RAW_SOCKET,
		required: { setup_test: true, capabilities: true, base_url: true }
	},
	ws_connection_cap: {
		derive: (c) => ({
			setup_test: c.setup(),
			capabilities: c.config.capabilities,
			base_url: c.config.base_url,
			ws_path: c.config.ws_path
		}),
		describe: describe_ws_connection_cap_cross_tests,
		transcript: TRANSCRIPT_WEBSOCKET,
		required: { setup_test: true, capabilities: true, base_url: true, ws_path: true }
	},
	ws_envelope: {
		derive: (c) => ({
			setup_test: c.setup(),
			capabilities: c.config.capabilities,
			base_url: c.config.base_url,
			ws_path: c.config.ws_path
		}),
		describe: describe_ws_envelope_cross_tests,
		transcript: TRANSCRIPT_WEBSOCKET,
		required: { setup_test: true, capabilities: true, base_url: true, ws_path: true }
	},
	ws_inbound_dispatch: {
		derive: (c) => ({
			setup_test: c.setup(),
			capabilities: c.config.capabilities,
			base_url: c.config.base_url,
			ws_path: c.config.ws_path
		}),
		describe: describe_ws_inbound_dispatch_cross_tests,
		transcript: TRANSCRIPT_WEBSOCKET,
		required: { setup_test: true, capabilities: true, base_url: true, ws_path: true }
	},
	ws_outbound_overflow: {
		derive: (c) => ({
			setup_test: c.setup(),
			capabilities: c.config.capabilities,
			base_url: c.config.base_url,
			ws_path: c.config.ws_path,
			rpc_path: c.config.rpc_path
		}),
		describe: describe_ws_outbound_overflow_cross_tests,
		transcript: TRANSCRIPT_WEBSOCKET,
		required: { setup_test: true, capabilities: true, base_url: true, ws_path: true },
		backdoors: ['_testing_flood_notifications']
	},
	ws_role_gated: {
		// the reference spines' role-gated endpoint; a backend mounting its own
		// overrides these, and one without it states `ws_role_gated: false`
		derive: (c) => ({
			setup_test: c.setup(),
			capabilities: c.config.capabilities,
			base_url: c.config.base_url,
			ws_path: c.config.ws_path,
			gated_ws_path: SPINE_ROLE_GATED_WS_PATH,
			gated_roles: SPINE_ROLE_GATED_WS_ROLES,
			scoped_role: SPINE_PARTICIPANT_ROLE
		}),
		describe: describe_ws_role_gated_cross_tests,
		transcript: TRANSCRIPT_WEBSOCKET,
		required: {
			setup_test: true,
			capabilities: true,
			base_url: true,
			ws_path: true,
			gated_ws_path: true,
			gated_roles: true,
			scoped_role: true
		}
	},
	ws_round_trip: {
		derive: (c) => ({
			setup_test: c.setup(),
			capabilities: c.config.capabilities,
			base_url: c.config.base_url,
			ws_path: c.config.ws_path,
			rpc_path: c.config.rpc_path,
			ws_account_roles: c.options.ws_required_roles,
			max_message_bytes: c.options.ws_max_message_bytes
		}),
		describe: describe_cross_process_ws_tests,
		transcript: TRANSCRIPT_WEBSOCKET,
		required: { setup_test: true, capabilities: true, base_url: true, ws_path: true }
	}
};

/** Merge two setups' invariant exclusions by name, to `all` alone when either excludes `all`. */
const merge_db_invariant_exclusions = (
	base: DbInvariantExclusions | undefined,
	seed: DbInvariantExclusions | undefined
): DbInvariantExclusions => {
	const all = base?.[DB_INVARIANTS_EXCLUDE_ALL] ?? seed?.[DB_INVARIANTS_EXCLUDE_ALL];
	return all !== undefined ? { [DB_INVARIANTS_EXCLUDE_ALL]: all } : { ...base, ...seed };
};

/**
 * Concatenate a suite's seeding onto the base setup options, and merge their
 * database invariant exclusions by name — to `all` alone when either side
 * excludes `all`, which a named entry beside it would make redundant.
 */
const merge_setup_options = (
	base: CrossProcessSetupOptions | undefined,
	seed: CrossProcessSetupOptions | undefined
): CrossProcessSetupOptions => ({
	...base,
	...seed,
	extra_keeper_roles: [...(base?.extra_keeper_roles ?? []), ...(seed?.extra_keeper_roles ?? [])],
	extra_accounts: [...(base?.extra_accounts ?? []), ...(seed?.extra_accounts ?? [])],
	extra_actors: [...(base?.extra_actors ?? []), ...(seed?.extra_actors ?? [])],
	exclude_db_invariants: merge_db_invariant_exclusions(
		base?.exclude_db_invariants,
		seed?.exclude_db_invariants
	)
});

/**
 * The backdoors every case of `name` drives beyond
 * `SPINE_SUITES_REQUIRED_BACKDOORS` — a backend not declaring one skips the
 * suite.
 *
 * @param name - the suite
 * @returns its `SuiteEntry.backdoors`, empty for a suite needing none
 * @internal
 */
export const get_spine_suite_backdoors = (name: SuiteName): ReadonlyArray<TestingBackdoorMethod> =>
	SUITE_ENTRIES[name].backdoors ?? [];

/**
 * Whether fuz_app's transcript differential runs `name` — the transcript's
 * suite list is the `'http'` ones.
 *
 * @param name - the suite
 * @returns its `SuiteEntry.transcript`
 * @internal Read by fuz_app's transcript differential — not stable API.
 */
export const get_spine_suite_transcript = (name: SuiteName): SpineSuiteTranscript =>
	SUITE_ENTRIES[name].transcript;

const is_suite_name = (name: string): name is SuiteName =>
	(SUITE_NAMES as ReadonlyArray<string>).includes(name);

/**
 * Each suite whose backdoors `declared` lacks, with the generated reason it is
 * skipped — the suites of `run` whose every case drives a backdoor (`SuiteEntry.backdoors`).
 */
const to_backdoor_skips = (
	declared: ReadonlyArray<string>,
	run: ReadonlySet<SuiteName>
): Map<SuiteName, string> => {
	const skips: Map<SuiteName, string> = new Map();
	for (const name of SUITE_NAMES) {
		if (!run.has(name)) continue;
		const missing = get_spine_suite_backdoors(name).filter((m) => !declared.includes(m));
		if (missing.length > 0) {
			skips.set(
				name,
				`needs ${missing.map((m) => `\`${m}\``).join(', ')}, which capabilities.testing_backdoors doesn't declare`
			);
		}
	}
	return skips;
};

/**
 * Refuse an exclude with an empty reason, an unknown suite name, a suite both
 * excluded and overridden, a backend missing a backdoor the suites share, an
 * exclude or override of a suite that skips itself for an undeclared
 * backdoor, any exclusion of an `UNEXCLUDABLE_SPINE_SUITES` suite, and an `exclude_cases` entry
 * naming a suite the call doesn't run or carrying no reason — before anything
 * is registered.
 */
const validate_spine_cross_suites_options = (
	options: SpineCrossSuitesOptions,
	declared: ReadonlyArray<string>,
	backdoor_skips: ReadonlyMap<SuiteName, string>,
	capabilities: BackendCapabilities,
	run: ReadonlySet<SuiteName>
): void => {
	// an entry for a suite the registration neither runs nor reads beside one it
	// runs (`SIBLING_READS`) would be ignored silently; a case exclusion is read
	// only by its own suite
	const read: Set<SuiteName> = new Set(run);
	for (const name of run) for (const sibling of SIBLING_READS[name] ?? []) read.add(sibling);
	for (const [field, names, live] of [
		['exclude', Object.keys(options.exclude ?? {}), read],
		['overrides', Object.keys(options.overrides ?? {}), read],
		['exclude_cases', Object.keys(options.exclude_cases ?? {}), run]
	] as const) {
		for (const name of names) {
			if (is_suite_name(name) && !live.has(name)) {
				throw new Error(
					`describe_spine_cross_suites: ${field} names '${name}', which the registration doesn't run`
				);
			}
		}
	}
	if (options.rpc_input_overrides?.size) {
		// a key the round-trip (the declared surface) and `rpc_adversarial` (that
		// and the live mount) both lack would be ignored silently — a typo
		const methods: Set<string> = new Set();
		for (const endpoint of options.surface_source.surface.rpc_endpoints) {
			for (const method of endpoint.methods) methods.add(method.name);
		}
		if (options.live_rpc_endpoints) {
			const live = resolve_rpc_endpoints_for_setup(
				options.live_rpc_endpoints,
				options.session_options
			);
			for (const endpoint of live) {
				for (const action of endpoint.actions) methods.add(action.spec.method);
			}
		}
		for (const method of options.rpc_input_overrides.keys()) {
			if (!methods.has(method)) {
				throw new Error(
					`describe_spine_cross_suites: rpc_input_overrides names '${method}', ` +
						`a method on neither the declared surface nor the live mount`
				);
			}
		}
	}
	for (const [name, reason] of Object.entries(options.exclude ?? {})) {
		if (!is_suite_name(name)) {
			throw new Error(`describe_spine_cross_suites: exclude names unknown suite '${name}'`);
		}
		if (typeof reason !== 'string' || reason.trim() === '') {
			throw new Error(`describe_spine_cross_suites: exclude '${name}' needs a reason`);
		}
		if (options.overrides?.[name] !== undefined) {
			throw new Error(`describe_spine_cross_suites: '${name}' is both excluded and overridden`);
		}
		const unexcludable = UNEXCLUDABLE_SPINE_SUITES[name];
		if (unexcludable !== undefined) {
			throw new Error(`describe_spine_cross_suites: '${name}' can't be excluded — ${unexcludable}`);
		}
		const skip = backdoor_skips.get(name);
		if (skip !== undefined) {
			throw new Error(
				`describe_spine_cross_suites: exclude '${name}' is redundant — the suite skips itself (${skip})`
			);
		}
	}
	for (const name of Object.keys(options.overrides ?? {})) {
		if (!is_suite_name(name)) {
			throw new Error(`describe_spine_cross_suites: overrides names unknown suite '${name}'`);
		}
		const skip = backdoor_skips.get(name);
		if (skip !== undefined) {
			throw new Error(
				`describe_spine_cross_suites: overrides names '${name}', which skips itself (${skip})`
			);
		}
	}
	if (options.expected_skips !== undefined) {
		assert_declared_skip_reasons(
			options.expected_skips,
			'describe_spine_cross_suites: expected_skips'
		);
	}
	for (const [name, cases] of Object.entries(options.exclude_cases ?? {})) {
		if (!is_suite_name(name)) {
			throw new Error(`describe_spine_cross_suites: exclude_cases names unknown suite '${name}'`);
		}
		if (options.exclude?.[name] !== undefined) {
			throw new Error(
				`describe_spine_cross_suites: '${name}' is excluded, so its exclude_cases entries name nothing`
			);
		}
		const unexcludable = UNEXCLUDABLE_SPINE_SUITES[name];
		if (unexcludable !== undefined) {
			throw new Error(
				`describe_spine_cross_suites: exclude_cases can't name '${name}' — ${unexcludable}, ` +
					'and a case of it failing is a wrong declaration or a bug, not a case to skip'
			);
		}
		const skip = backdoor_skips.get(name);
		if (skip !== undefined) {
			throw new Error(
				`describe_spine_cross_suites: exclude_cases names '${name}', which skips itself (${skip})`
			);
		}
		const entries = Object.entries(cases ?? {});
		if (entries.length === 0) {
			throw new Error(`describe_spine_cross_suites: exclude_cases '${name}' names no test`);
		}
		for (const [test_name, reason] of entries) {
			if (typeof reason !== 'string' || reason.trim() === '') {
				throw new Error(
					`describe_spine_cross_suites: exclude_cases '${name}' › '${test_name}' needs a reason`
				);
			}
		}
	}
	const missing = SPINE_SUITES_REQUIRED_BACKDOORS.filter((m) => !declared.includes(m));
	if (missing.length > 0) {
		throw new Error(
			`describe_spine_cross_suites: capabilities.testing_backdoors must declare ${missing.join(', ')} ` +
				'— every suite resets through _testing_reset and reads audit rows behind _testing_drain_effects'
		);
	}
	if (
		!declared.includes('_testing_db_invariants') &&
		options.setup?.exclude_db_invariants?.[DB_INVARIANTS_EXCLUDE_ALL] === undefined
	) {
		throw new Error(
			'describe_spine_cross_suites: capabilities.testing_backdoors must declare ' +
				'_testing_db_invariants — every setup checks the database invariants through it after ' +
				`each test — or turn the check off with setup: {exclude_db_invariants: {${DB_INVARIANTS_EXCLUDE_ALL}: '<reason>'}}`
		);
	}
	if (capabilities.fact_serving && !declared.includes('_testing_put_fact')) {
		throw new Error(
			'describe_spine_cross_suites: capabilities.fact_serving needs _testing_put_fact in ' +
				'capabilities.testing_backdoors — the fact suites seed through it'
		);
	}
	if (capabilities.rooms && !declared.includes('_testing_room_evict')) {
		throw new Error(
			'describe_spine_cross_suites: capabilities.rooms needs _testing_room_evict in ' +
				'capabilities.testing_backdoors — the rooms suite evicts through it'
		);
	}
};

/**
 * Whether two option values are the same: primitives by identity, lists as
 * multisets, objects key by key. Names the keys that differ, for an object.
 */
const differing_keys = (a: unknown, b: unknown): Array<string> | null => {
	if (a === b) return [];
	if (Array.isArray(a) && Array.isArray(b)) {
		const key = (list: ReadonlyArray<unknown>) =>
			list
				.map((v) => JSON.stringify(v))
				.sort()
				.join(',');
		return key(a) === key(b) ? [] : null;
	}
	if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
		const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
		return [...keys].filter(
			(k) =>
				differing_keys((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
					?.length !== 0
		);
	}
	return null;
};

/**
 * Hold an override of an unexcludable suite to its allowlist
 * (`UNEXCLUDABLE_OVERRIDE_KEYS`): any key with its derived value passes, a
 * free key with any value, a droppable key with `undefined`, and every other
 * change throws. Other suites pass unchecked.
 *
 * @param name - the suite
 * @param patch - the override's patch, as merged over `derived`
 * @param derived - the options the handle gives
 * @throws Error - naming the key, on a fixed key moved or a key not admitted
 * @internal Used by `describe_spine_cross_suites` and its tests — not stable API.
 */
export const check_unexcludable_override = (
	name: SuiteName,
	patch: object | undefined,
	derived: object
): void => {
	if (!(name in UNEXCLUDABLE_OVERRIDE_KEYS) || patch === undefined) return;
	const keys = UNEXCLUDABLE_OVERRIDE_KEYS[name as UnexcludableSuiteName];
	const free: ReadonlySet<string> = new Set(keys.free);
	const fixed: ReadonlySet<string> = new Set(keys.fixed);
	const droppable: ReadonlySet<string> = new Set(keys.droppable);
	const why = UNEXCLUDABLE_SPINE_SUITES[name];
	for (const [key, value] of Object.entries(patch)) {
		const derived_value = (derived as Record<string, unknown>)[key];
		// an unchanged value is no override, whatever the key
		if (differing_keys(value, derived_value)?.length === 0) continue;
		if (free.has(key)) continue;
		if (droppable.has(key) && value === undefined) continue;
		if (!fixed.has(key) && !droppable.has(key)) {
			const admitted = [
				...keys.free,
				...keys.droppable.map((k) => `${k} (unchanged or undefined)`),
				...keys.fixed.map((k) => `${k} (unchanged)`)
			];
			throw new Error(
				`describe_spine_cross_suites: overrides can't set '${name}' ${key} — ${why}; ` +
					`it admits ${admitted.length > 0 ? admitted.join(', ') : 'nothing'}`
			);
		}
		const differs = differing_keys(value, derived_value);
		throw new Error(
			`describe_spine_cross_suites: overrides can't change '${name}' ${key}` +
				`${differs?.length ? ` (${differs.join(', ')})` : ''} — ${why}`
		);
	}
};

/**
 * Derive a suite's options and merge its override over them — the allowlist
 * of an unexcludable suite checked — with no required-option check (a
 * sibling's read of them needs none).
 */
const merge_suite_options = <K extends SuiteName>(
	name: K,
	context: SuiteContext
): SuiteOptionsMap[K] => {
	const derived = SUITE_ENTRIES[name].derive(context);
	const override: SuiteOverride<K> | undefined = context.options.overrides?.[name];
	const patch = typeof override === 'function' ? override(derived) : override;
	check_unexcludable_override(name, patch, derived);
	const merged = { ...derived, ...patch };
	return context.wrap_setup_test
		? wrap_setup_slots(derived, merged, context.wrap_setup_test)
		: merged;
};

/**
 * Wrap every setup in `merged` at a slot where `derived` held one `setup`
 * returned — top-level (`setup_test`, `setup_test_multi_actor`) or one object
 * down (`multi_actor.setup_test`) — whether the derived setup is still there
 * or an override replaced it. Only an object directly holding a derived setup
 * is rebuilt; every other value passes through as the same instance (a `Map`,
 * a class instance, the declared surface). A setup an override adds at a key
 * the derive never filled, or deeper than one object level, isn't wrapped.
 */
const wrap_setup_slots = <T>(
	derived: T,
	merged: T,
	{
		wrap,
		derived_setups
	}: {
		readonly wrap: (setup_test: SetupTest) => SetupTest;
		readonly derived_setups: WeakSet<SetupTest>;
	},
	depth = 0
): T => {
	const is_derived_setup = (v: unknown): boolean =>
		typeof v === 'function' && derived_setups.has(v as SetupTest);
	const out: Record<string, unknown> = { ...(merged as Record<string, unknown>) };
	for (const [key, held] of Object.entries(derived as Record<string, unknown>)) {
		const value = out[key];
		if (is_derived_setup(held)) {
			if (typeof value === 'function') out[key] = wrap(value as SetupTest);
		} else if (
			depth === 0 &&
			held !== null &&
			typeof held === 'object' &&
			!Array.isArray(held) &&
			Object.values(held).some(is_derived_setup) &&
			value !== null &&
			typeof value === 'object' &&
			!Array.isArray(value)
		) {
			out[key] = wrap_setup_slots(held, value, { wrap, derived_setups }, depth + 1);
		}
	}
	return out as T;
};

const run_suite = <K extends SuiteName>(name: K, context: SuiteContext): void => {
	const entry: SuiteEntry<K> = SUITE_ENTRIES[name];
	const suite_options = context.merged(name);
	for (const field of Object.keys(entry.required)) {
		const value: unknown = suite_options[field as keyof SuiteOptionsMap[K]];
		if (value === undefined || value === '') {
			const remedy =
				UNEXCLUDABLE_SPINE_SUITES[name] === undefined
					? `pass \`overrides.${name}\` with it or exclude '${name}' with a reason`
					: `pass \`overrides.${name}\` with it`;
			throw new Error(
				`describe_spine_cross_suites: '${name}' needs \`${field}\`, which neither the handle ` +
					`nor the override gives — ${remedy}`
			);
		}
	}
	entry.describe(suite_options);
};

/** The top-level tasks one suite registered, as indices into the calling suite's tasks. */
export interface SuiteTaskRange {
	readonly name: SuiteName;
	readonly start: number;
	readonly end: number;
}

/**
 * Where `task` sits below `root`: its name path (its describe titles and its
 * name) and its top-level ancestor, one of `root`'s own tasks — or `null`
 * outside `root`.
 */
const locate_task = (
	task: RunnerTask,
	root: RunnerTask
): { path: Array<string>; top: RunnerTask } | null => {
	const path: Array<string> = [];
	let current: RunnerTask = task;
	for (;;) {
		path.unshift(current.name);
		// a test or describe at a file's top level has no `suite`, only its `file`
		const parent: RunnerTask | undefined = current.suite ?? current.file;
		if (parent === root) return { path, top: current };
		if (!parent || parent === current) return null;
		current = parent;
	}
};

/** Every test under `task`, as name paths starting with `prefix`. */
const collect_test_paths = (task: RunnerTask, prefix: Array<string>, out: Set<string>): void => {
	const path = [...prefix, task.name];
	if (task.type === 'suite') {
		for (const child of task.tasks) collect_test_paths(child, path, out);
	} else {
		out.add(path.join(' > '));
	}
};

/**
 * Check every `exclude_cases` entry against the test paths each suite
 * collected — the static half of the case exclusions, which the closing test
 * `register_spine_case_exclusions` registers runs.
 *
 * @param exclude_cases - the entries, by suite
 * @param collected - each run suite's collected test paths
 * @throws Error - naming every entry whose suite collected no test at its path
 * @internal
 */
export const check_spine_case_exclusions = (
	exclude_cases: SuiteCaseExclusions,
	collected: ReadonlyMap<SuiteName, ReadonlySet<string>>
): void => {
	const dead: Array<string> = [];
	for (const [name, cases] of Object.entries(exclude_cases) as Array<
		[SuiteName, Readonly<Record<string, string>> | undefined]
	>) {
		const paths = collected.get(name);
		for (const test_name of Object.keys(cases ?? {})) {
			if (!paths?.has(test_name)) dead.push(`${name} › ${test_name}`);
		}
	}
	if (dead.length > 0) {
		throw new Error(
			`exclude_cases entries naming no collected test of their suite (a renamed or removed ` +
				`test, or a path missing a describe title): ${dead.join('; ')}`
		);
	}
};

/**
 * Skip the `exclude_cases` tests, and fail on an entry no collected test has.
 * `describe_spine_cross_suites` calls it after registering the suites, in the
 * same suite.
 *
 * One `beforeEach` on the calling suite: it finds the test's top-level task
 * among the ranges the suites registered, and calls `ctx.skip(reason)` when
 * that suite's entries name the test's path — so the suite files stay as they
 * are, and the test shows as skipped with its reason. A closing test holds
 * every entry to a test its suite collected (`check_spine_case_exclusions`;
 * the paths are read at collection, so a filtered run still checks them).
 * A skipped test's own `beforeEach` hooks don't run, but its `afterEach`
 * hooks and its suite's `beforeAll` still do.
 *
 * @param exclude_cases - the entries, by suite
 * @param ranges - each run suite's top-level tasks in the calling suite
 * @internal
 */
export const register_spine_case_exclusions = (
	exclude_cases: SuiteCaseExclusions,
	ranges: ReadonlyArray<SuiteTaskRange>
): void => {
	let root: Readonly<RunnerTestSuite | RunnerTestFile> | undefined;
	const collected: Map<SuiteName, Set<string>> = new Map();
	const suite_of = (index: number): SuiteName | undefined =>
		ranges.find((r) => index >= r.start && index < r.end)?.name;

	// vitest passes the suite a hook is registered on as the second argument,
	// and requires the first be destructured
	// eslint-disable-next-line no-empty-pattern
	beforeAll(({}, suite) => {
		root = suite;
		for (const range of ranges) {
			const paths: Set<string> = new Set();
			for (const task of suite.tasks.slice(range.start, range.end)) {
				collect_test_paths(task, [], paths);
			}
			collected.set(range.name, paths);
		}
	});

	beforeEach((ctx) => {
		if (!root) return;
		const located = locate_task(ctx.task, root);
		if (!located) return;
		const name = suite_of(root.tasks.indexOf(located.top));
		if (name === undefined) return;
		const reason = exclude_cases[name]?.[located.path.join(' > ')];
		if (reason !== undefined) ctx.skip(`excluded on this backend: ${reason}`);
	});

	test('spine cross suites: every exclude_cases entry names a collected test', () => {
		check_spine_case_exclusions(exclude_cases, collected);
	});
};

/**
 * What `register_spine_suites` registers beyond `describe_spine_cross_suites`'s defaults.
 *
 * @internal Used by fuz_app's transcript differential — not stable API.
 */
export interface SpineSuiteRegistration {
	/**
	 * The suites to register, run in `SUITE_NAMES` order whatever the order
	 * given; default every suite. An `exclude` or override naming a suite
	 * outside it is refused as dead unless a listed suite reads it beside its
	 * own (the mount suite reads its probes' siblings), and an `exclude_cases`
	 * entry outside it always is.
	 */
	readonly names?: ReadonlyArray<SuiteName>;
	/**
	 * Wraps every suite's `setup_test` — the transcript differential's
	 * recorder — after its override merge, so a setup an override supplies is
	 * wrapped too; also the multi-actor setups a suite derives. A setup an
	 * override adds at a key the derive never filled, or deeper than one object
	 * level, isn't wrapped.
	 */
	readonly wrap_setup_test?: (setup_test: SetupTest) => SetupTest;
}

/**
 * `describe_spine_cross_suites` over a chosen set of suites, each suite's
 * `setup_test` passed through a wrapper — so another runner over the suites
 * (fuz_app's transcript differential) builds every suite's options as the
 * one call does and can't drift from it.
 *
 * @param handle - the backend, as `inject_backend_handle()` returns it
 * @param options - as `describe_spine_cross_suites` takes them
 * @param registration - the suites to register and the setup wrapper
 * @throws Error - as `describe_spine_cross_suites`, and on an empty, unknown
 *   or repeated name, or an `exclude`, override or `exclude_cases` entry for a
 *   suite the registration neither runs nor reads
 * @internal Used by `describe_spine_cross_suites` and fuz_app's transcript differential — not stable API.
 */
export const register_spine_suites = (
	handle: ReconstructedBootstrappedBackendHandle,
	options: SpineCrossSuitesOptions,
	registration: SpineSuiteRegistration
): void => {
	const run = to_registered_names(registration.names);
	const config = to_cross_suite_options(handle);
	const declared: ReadonlyArray<string> = config.capabilities.testing_backdoors;
	const backdoor_skips = to_backdoor_skips(declared, run);
	validate_spine_cross_suites_options(options, declared, backdoor_skips, config.capabilities, run);
	const derived_setups: WeakSet<SetupTest> = new WeakSet();
	const merged: Map<SuiteName, unknown> = new Map();
	const context: SuiteContext = {
		handle,
		config,
		options,
		setup: (seed) => {
			const setup_test = default_cross_process_setup(
				handle,
				merge_setup_options(options.setup, seed)
			);
			derived_setups.add(setup_test);
			return setup_test;
		},
		wrap_setup_test:
			registration.wrap_setup_test === undefined
				? null
				: { wrap: registration.wrap_setup_test, derived_setups },
		ws: config.capabilities.ws ? { base_url: config.base_url, ws_path: config.ws_path } : undefined,
		merged: <K extends SuiteName>(name: K): SuiteOptionsMap[K] => {
			if (!merged.has(name)) merged.set(name, merge_suite_options(name, context));
			return merged.get(name) as SuiteOptionsMap[K];
		}
	};
	// each suite's top-level tasks, by index, so the case exclusions know which
	// suite a test belongs to
	const collector = TestRunner.getCurrentSuite();
	const ranges: Array<SuiteTaskRange> = [];
	// an exclude of a suite the registration only reads (`SIBLING_READS`) shows
	// no skip: the suite wasn't to run here anyway
	const excluded_run: Array<[string, string]> = Object.entries(options.exclude ?? {}).filter(
		([name]) => run.has(name as SuiteName)
	);
	const skipped: Array<[string, string]> = [...excluded_run];
	for (const name of SUITE_NAMES) {
		if (!run.has(name) || options.exclude?.[name] !== undefined) continue;
		const skip = backdoor_skips.get(name);
		if (skip !== undefined) {
			skipped.push([name, skip]);
			continue;
		}
		const start = collector.tasks.length;
		run_suite(name, context);
		ranges.push({ name, start, end: collector.tasks.length });
	}
	if (Object.keys(options.exclude_cases ?? {}).length > 0) {
		register_spine_case_exclusions(options.exclude_cases!, ranges);
	}
	if (skipped.length > 0) {
		describe(SPINE_SUITES_SKIPPED_TITLE, () => {
			for (const [name, reason] of skipped) test_skip_gated(`${name}: ${reason}`, () => {});
		});
	}
	if (options.expected_skips !== undefined) {
		// an exclude is its suite's declaration; a backdoor skip is owed one
		const excluded = Object.fromEntries(
			excluded_run.map(([name, reason]) => [
				`${SPINE_SUITES_SKIPPED_TITLE} > ${name}: ${reason}`,
				reason
			])
		);
		check_declared_skips({ ...excluded, ...options.expected_skips });
	}
};

/** The suites a registration runs, refusing an empty, unknown or repeated name. */
const to_registered_names = (
	names: ReadonlyArray<SuiteName> | undefined
): ReadonlySet<SuiteName> => {
	if (names === undefined) return new Set(SUITE_NAMES);
	if (names.length === 0) throw new Error('register_spine_suites: names is empty');
	const run: Set<SuiteName> = new Set();
	for (const name of names) {
		if (!is_suite_name(name)) {
			throw new Error(`register_spine_suites: names lists unknown suite '${name}'`);
		}
		if (run.has(name)) throw new Error(`register_spine_suites: names lists '${name}' twice`);
		run.add(name);
	}
	return run;
};

/**
 * Run every shipped single-backend cross suite against one spawned backend —
 * see the module doc for what the options add and what stays outside.
 *
 * @param handle - the backend, as `inject_backend_handle()` returns it
 * @param options - the declared surface, plus excludes, case exclusions and overrides
 * @throws Error - on an exclude or `expected_skips` entry with no reason, an unknown suite name, a suite
 *   both excluded and overridden, an excluded `UNEXCLUDABLE_SPINE_SUITES` suite
 *   (or one of its cases, or an override changing the declaration it checks), an exclude,
 *   override or `exclude_cases` entry for a suite that skips itself or isn't
 *   run, a backend not declaring `SPINE_SUITES_REQUIRED_BACKDOORS` (or
 *   `_testing_db_invariants` without `setup.exclude_db_invariants.all`, or
 *   `_testing_put_fact` with `fact_serving`, or `_testing_room_evict` with
 *   `rooms`), or a suite missing an input the
 *   handle doesn't carry
 */
export const describe_spine_cross_suites = (
	handle: ReconstructedBootstrappedBackendHandle,
	options: SpineCrossSuitesOptions
): void => {
	register_spine_suites(handle, options, {});
};

/** The `describe` holding one skipped test per suite the call leaves out. */
export const SPINE_SUITES_SKIPPED_TITLE = 'spine cross suites excluded on this backend';
