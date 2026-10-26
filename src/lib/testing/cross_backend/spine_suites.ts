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
 *   stated in code and visible in the report.
 * - `overrides` replaces a suite's derived options, field by field (a shallow
 *   merge over what the handle gives) — a role list the backend's WS upgrade
 *   requires, an `xfail` for a tracked divergence, a narrower capability set.
 *   An entry can be a function of the derived options instead, for a change
 *   built on a derived value. A required option the merge leaves `undefined`
 *   throws at collection.
 * - `rpc_success_fixtures` / `rpc_skip_methods` / `rpc_input_overrides` go to
 *   the standard bundle's RPC round-trip.
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
 * **Not in the one call** (`STANDALONE_CROSS_SUITES`, with the reasons): the
 * suites that need two handles (the differential), a backend spawned with live
 * limiters (`login_security`, `ws_action_rate_limit` — the standard suites would
 * exhaust them), and the conformance runner, which runs the consumer's own
 * cases. Each keeps its own entry point.
 *
 * Suites are registered without a wrapping `describe`, so their test names are
 * the same as when each is called on its own.
 *
 * @module
 */

import { describe, test } from 'vitest';

import { ROLE_KEEPER, ROLE_ADMIN, type RoleSchemaResult } from '../../auth/role_schema.ts';
import type { SessionOptions } from '../../auth/session_cookie.ts';
import type { AppSurfaceSpec } from '../../http/surface.ts';
import type { RpcEndpointsSuiteOption } from '../rpc_helpers.ts';
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
import { describe_cell_crud_cross_tests } from './cell_crud.ts';
import { describe_cell_gated_create_cross_tests } from './cell_gated_create.ts';
import {
	CELL_EDITOR_ROLE,
	CELL_ROLE_HOLDER_USERNAME,
	describe_cell_grant_role_cross_tests
} from './cell_grant_role.ts';
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
	SPINE_ROLE_GATED_WS_ROLES
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
	'cell_crud',
	'cell_gated_create',
	'cell_grant_role',
	'cell_moderate',
	'cell_ref_admission',
	'cell_relations',
	'cookie_attributes',
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
	'role_grant_offer_enumeration',
	'role_grant_offer_lifecycle',
	'role_grant_offer_notification_ws',
	'role_grant_participation',
	'role_grant_role_grammar',
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

/** The options each suite takes, by `SuiteName` — what `overrides` entries are partials of. */
export interface SuiteOptionsMap {
	account_lifecycle: AccountLifecycleCrossTestOptions;
	actor_lookup: ActorLookupCrossTestOptions;
	app_settings: AppSettingsCrossTestOptions;
	body_size: BodySizeCrossTestOptions;
	body_size_smuggling: BodySizeSmugglingCrossTestOptions;
	cell_crud: RpcPathCapabilityGatedCrossSuiteOptions;
	cell_gated_create: RpcPathCapabilityGatedCrossSuiteOptions;
	cell_grant_role: RpcPathCapabilityGatedCrossSuiteOptions;
	cell_moderate: RpcPathCapabilityGatedCrossSuiteOptions;
	cell_ref_admission: RpcPathCapabilityGatedCrossSuiteOptions;
	cell_relations: RpcPathCapabilityGatedCrossSuiteOptions;
	cookie_attributes: CookieAttributesCrossTestOptions;
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
	role_grant_offer_enumeration: RoleGrantOfferEnumerationCrossTestOptions;
	role_grant_offer_lifecycle: RoleGrantOfferLifecycleCrossTestOptions;
	role_grant_offer_notification_ws: RoleGrantOfferNotificationWsTestOptions;
	role_grant_participation: RoleGrantParticipationCrossTestOptions;
	role_grant_role_grammar: RoleGrantRoleGrammarCrossTestOptions;
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

/** Options for `describe_spine_cross_suites`. */
export interface SpineCrossSuitesOptions {
	/** The declared surface — the standard bundle and `rpc_adversarial` enumerate it. */
	readonly surface_source: AppSurfaceSpec;
	/** The backend's session config, for the standard bundle. */
	readonly session_options: SessionOptions<string>;
	/** The backend's RPC endpoints, for the standard bundle. */
	readonly rpc_endpoints: RpcEndpointsSuiteOption;
	/** The backend's role schema; given, the standard bundle runs its admin suite. */
	readonly roles?: RoleSchemaResult;
	/**
	 * Setup options every suite's `setup_test` starts from — a signup path the
	 * backend mounts elsewhere, `reject_unknown_audit_metadata_keys` for a
	 * backend's own spine suite. A suite's own seeding is added to it (the role,
	 * account and actor lists concatenate).
	 */
	readonly setup?: CrossProcessSetupOptions;
	/**
	 * Suites this backend doesn't run, each with a non-empty reason. Each shows
	 * in the run as one skipped test carrying the reason.
	 */
	readonly exclude?: Readonly<Partial<Record<SuiteName, string>>>;
	/** Per-suite option overrides, a shallow merge over what the handle gives. */
	readonly overrides?: SuiteOverrides;
	/** Forwarded to the standard bundle (`StandardCrossProcessTestOptions.rpc_success_fixtures`). */
	readonly rpc_success_fixtures?: RpcSuccessFixtures;
	/** Forwarded to the standard bundle (`StandardCrossProcessTestOptions.rpc_skip_methods`). */
	readonly rpc_skip_methods?: Array<string>;
	/** Forwarded to the standard bundle (`StandardCrossProcessTestOptions.rpc_input_overrides`). */
	readonly rpc_input_overrides?: Map<string, Record<string, unknown>>;
}

/** What a suite's entry builds its options from. */
interface SuiteContext {
	readonly handle: ReconstructedBootstrappedBackendHandle;
	readonly config: CrossSuiteHandleOptions;
	readonly options: SpineCrossSuitesOptions;
	/** A `setup_test` from the base setup options plus this suite's seeding. */
	readonly setup: (seed?: CrossProcessSetupOptions) => SetupTest;
	/** `{base_url, ws_path}` when the backend mounts WS, for suites whose socket cases are optional. */
	readonly ws: { readonly base_url: string; readonly ws_path: string } | undefined;
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
}

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
		required: { setup_test: true, capabilities: true }
	},
	actor_lookup: {
		derive: (c) => ({ setup_test: c.setup(), rpc_path: c.config.rpc_path }),
		describe: describe_actor_lookup_cross_tests,
		required: { setup_test: true }
	},
	app_settings: {
		derive: (c) => ({ setup_test: c.setup(), rpc_path: c.config.rpc_path }),
		describe: describe_app_settings_cross_tests,
		required: { setup_test: true }
	},
	body_size: {
		derive: (c) => ({
			setup_test: c.setup(),
			rpc_path: c.config.rpc_path,
			base_url: c.config.base_url
		}),
		describe: describe_body_size_cross_tests,
		required: { setup_test: true, base_url: true }
	},
	body_size_smuggling: {
		derive: (c) => ({ base_url: c.config.base_url, rpc_path: c.config.rpc_path }),
		describe: describe_body_size_smuggling_cross_tests,
		required: { base_url: true }
	},
	cell_crud: {
		derive: (c) => rpc_gated(c),
		describe: describe_cell_crud_cross_tests,
		required: { setup_test: true, capabilities: true }
	},
	cell_gated_create: {
		derive: (c) => rpc_gated(c),
		describe: describe_cell_gated_create_cross_tests,
		required: { setup_test: true, capabilities: true }
	},
	cell_grant_role: {
		// the holder is seeded at reset: `CELL_EDITOR_ROLE` has no grant path
		derive: (c) =>
			rpc_gated(c, {
				extra_accounts: [{ username: CELL_ROLE_HOLDER_USERNAME, roles: [CELL_EDITOR_ROLE] }]
			}),
		describe: describe_cell_grant_role_cross_tests,
		required: { setup_test: true, capabilities: true }
	},
	cell_moderate: {
		derive: (c) => rpc_gated(c),
		describe: describe_cell_moderate_cross_tests,
		required: { setup_test: true, capabilities: true }
	},
	cell_ref_admission: {
		derive: (c) => rpc_gated(c),
		describe: describe_cell_ref_admission_cross_tests,
		required: { setup_test: true, capabilities: true }
	},
	cell_relations: {
		derive: (c) => rpc_gated(c),
		describe: describe_cell_relations_cross_tests,
		required: { setup_test: true, capabilities: true }
	},
	cookie_attributes: {
		derive: (c) => ({ setup_test: c.setup(), cookie_name: c.config.cookie_name }),
		describe: describe_cookie_attributes_cross_tests,
		required: { setup_test: true, cookie_name: true }
	},
	credential_deadline: {
		derive: (c) => ({
			setup_test: c.setup(),
			capabilities: c.config.capabilities,
			base_url: c.config.base_url,
			ws_path: c.config.ws_path,
			sse_path: c.config.sse_path,
			rpc_path: c.config.rpc_path
		}),
		describe: describe_credential_deadline_cross_tests,
		required: { setup_test: true, capabilities: true, base_url: true, ws_path: true }
	},
	credential_header_robustness: {
		derive: (c) => ({
			base_url: c.config.base_url,
			rpc_path: c.config.rpc_path,
			daemon_token: c.handle.daemon_token
		}),
		describe: describe_credential_header_robustness_cross_tests,
		required: { base_url: true, daemon_token: true }
	},
	fact_serving: {
		// the multi-actor setup reaches the fallthrough a single-actor keeper can't
		derive: (c) => ({
			...rpc_gated(c),
			setup_test_multi_actor: c.setup({ extra_actors: ['second_persona'] })
		}),
		describe: describe_fact_serving_cross_tests,
		required: { setup_test: true, capabilities: true }
	},
	identity_parity: {
		derive: (c) => ({ setup_test: c.setup() }),
		describe: describe_identity_parity_cross_tests,
		required: { setup_test: true }
	},
	origin: {
		derive: (c) => ({ setup_test: c.setup(), rpc_path: c.config.rpc_path }),
		describe: describe_origin_cross_tests,
		required: { setup_test: true }
	},
	origin_conformance: {
		derive: (c) => ({ setup_test: c.setup(), rpc_path: c.config.rpc_path }),
		describe: describe_origin_conformance_cross_tests,
		required: { setup_test: true }
	},
	origin_scope: {
		derive: (c) => ({
			setup_test: c.setup(),
			capabilities: c.config.capabilities,
			base_url: c.config.base_url
		}),
		describe: describe_origin_scope_cross_tests,
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
		required: { setup_test: true, capabilities: true, base_url: true, ws_path: true }
	},
	query_shape: {
		derive: (c) => rpc_gated(c),
		describe: describe_query_shape_cross_tests,
		required: { setup_test: true, capabilities: true }
	},
	ready: {
		derive: (c) => ({ setup_test: c.setup(), capabilities: c.config.capabilities }),
		describe: describe_ready_cross_tests,
		required: { setup_test: true, capabilities: true }
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
		required: { setup_test: true }
	},
	role_grant_offer_lifecycle: {
		derive: (c) => ({ setup_test: c.setup(), rpc_path: c.config.rpc_path }),
		describe: describe_role_grant_offer_lifecycle_cross_tests,
		required: { setup_test: true }
	},
	role_grant_offer_notification_ws: {
		derive: (c) => ({
			setup_test: c.setup(),
			capabilities: c.config.capabilities,
			base_url: c.config.base_url,
			ws_path: c.config.ws_path
		}),
		describe: describe_role_grant_offer_notification_ws_tests,
		required: { setup_test: true, capabilities: true, base_url: true, ws_path: true }
	},
	role_grant_participation: {
		derive: (c) => ({ setup_test: c.setup(), rpc_path: c.config.rpc_path }),
		describe: describe_role_grant_participation_cross_tests,
		required: { setup_test: true }
	},
	role_grant_role_grammar: {
		derive: (c) => ({ setup_test: c.setup(), rpc_path: c.config.rpc_path }),
		describe: describe_role_grant_role_grammar_cross_tests,
		required: { setup_test: true }
	},
	rpc_adversarial: {
		derive: (c) => ({
			setup_test: c.setup(),
			surface_source: c.options.surface_source,
			rpc_path: c.config.rpc_path
		}),
		describe: describe_rpc_adversarial_cross_tests,
		required: { setup_test: true, surface_source: true }
	},
	session_cap: {
		derive: (c) => ({ setup_test: c.setup(), ws: c.ws }),
		describe: describe_session_cap_cross_tests,
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
		required: { setup_test: true, cookie_name: true, cookie_keys: true }
	},
	simple_request: {
		derive: (c) => ({ setup_test: c.setup(), rpc_path: c.config.rpc_path }),
		describe: describe_simple_request_cross_tests,
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
			rpc_input_overrides: c.options.rpc_input_overrides
		}),
		describe: describe_standard_cross_process_tests,
		required: {
			setup_test: true,
			surface_source: true,
			session_options: true,
			rpc_endpoints: true,
			capabilities: true
		}
	},
	testing_backdoor: {
		derive: (c) => ({ setup_test: c.setup(), rpc_path: c.config.rpc_path, ws: c.ws }),
		describe: describe_testing_backdoor_cross_tests,
		required: { setup_test: true }
	},
	token_lifetime: {
		derive: (c) => ({ setup_test: c.setup(), rpc_path: c.config.rpc_path }),
		describe: describe_token_lifetime_cross_tests,
		required: { setup_test: true }
	},
	token_scope_surface: {
		derive: (c) => ({ ...rpc_gated(c), sse_path: c.config.sse_path }),
		describe: describe_token_scope_surface_cross_tests,
		required: { setup_test: true, capabilities: true }
	},
	transport_composition: {
		derive: (c) => ({
			...rpc_gated(c),
			base_url: c.config.base_url,
			ws_path: c.config.ws_path,
			sse_path: c.config.sse_path,
			multi_actor: { setup_test: c.setup({ extra_actors: ['keeper_second_persona'] }) }
		}),
		describe: describe_transport_composition_cross_tests,
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
		required: { setup_test: true, capabilities: true, base_url: true, ws_path: true }
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
			rpc_path: c.config.rpc_path
		}),
		describe: describe_cross_process_ws_tests,
		required: { setup_test: true, capabilities: true, base_url: true, ws_path: true }
	}
};

/** Concatenate a suite's seeding onto the base setup options. */
const merge_setup_options = (
	base: CrossProcessSetupOptions | undefined,
	seed: CrossProcessSetupOptions | undefined
): CrossProcessSetupOptions => ({
	...base,
	...seed,
	extra_keeper_roles: [...(base?.extra_keeper_roles ?? []), ...(seed?.extra_keeper_roles ?? [])],
	extra_accounts: [...(base?.extra_accounts ?? []), ...(seed?.extra_accounts ?? [])],
	extra_actors: [...(base?.extra_actors ?? []), ...(seed?.extra_actors ?? [])]
});

const is_suite_name = (name: string): name is SuiteName =>
	(SUITE_NAMES as ReadonlyArray<string>).includes(name);

/**
 * Refuse an exclude with an empty reason, an unknown suite name, and a suite
 * both excluded and overridden — before anything is registered.
 */
const validate_spine_cross_suites_options = (options: SpineCrossSuitesOptions): void => {
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
	}
	for (const name of Object.keys(options.overrides ?? {})) {
		if (!is_suite_name(name)) {
			throw new Error(`describe_spine_cross_suites: overrides names unknown suite '${name}'`);
		}
	}
};

const run_suite = <K extends SuiteName>(name: K, context: SuiteContext): void => {
	const entry: SuiteEntry<K> = SUITE_ENTRIES[name];
	const derived = entry.derive(context);
	const override: SuiteOverride<K> | undefined = context.options.overrides?.[name];
	const patch = typeof override === 'function' ? override(derived) : override;
	const suite_options: SuiteOptionsMap[K] = { ...derived, ...patch };
	for (const field of Object.keys(entry.required)) {
		const value: unknown = suite_options[field as keyof SuiteOptionsMap[K]];
		if (value === undefined || value === '') {
			throw new Error(
				`describe_spine_cross_suites: '${name}' needs \`${field}\`, which neither the handle ` +
					`nor the override gives — pass \`overrides.${name}\` with it or exclude '${name}' with a reason`
			);
		}
	}
	entry.describe(suite_options);
};

/**
 * Run every shipped single-backend cross suite against one spawned backend —
 * see the module doc for what the options add and what stays outside.
 *
 * @param handle - the backend, as `inject_backend_handle()` returns it
 * @param options - the declared surface, plus excludes and overrides
 * @throws Error - on an exclude with no reason, an unknown suite name, a suite
 *   both excluded and overridden, or a suite missing an input the handle
 *   doesn't carry
 */
export const describe_spine_cross_suites = (
	handle: ReconstructedBootstrappedBackendHandle,
	options: SpineCrossSuitesOptions
): void => {
	validate_spine_cross_suites_options(options);
	const config = to_cross_suite_options(handle);
	const context: SuiteContext = {
		handle,
		config,
		options,
		setup: (seed) => default_cross_process_setup(handle, merge_setup_options(options.setup, seed)),
		ws: config.capabilities.ws ? { base_url: config.base_url, ws_path: config.ws_path } : undefined
	};
	const excluded = Object.entries(options.exclude ?? {});
	for (const name of SUITE_NAMES) {
		if (options.exclude?.[name] !== undefined) continue;
		run_suite(name, context);
	}
	if (excluded.length > 0) {
		describe('spine cross suites excluded on this backend', () => {
			for (const [name, reason] of excluded) test.skip(`${name}: ${reason}`, () => {});
		});
	}
};
