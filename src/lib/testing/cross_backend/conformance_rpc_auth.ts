import '../assert_dev_env.ts';

/**
 * Per-method RPC auth rows for the conformance table, generated from the
 * declared surface and, when given, the methods a backend live-mounts off it.
 *
 * `describe_rpc_attack_surface_tests` walks every declared method's auth, but
 * only in-process against stub apps with no database, so it never reaches a
 * spawned backend. The hand-written conformance rows reach every backend but
 * cover a chosen few methods. A spine that hand-implements a method's gate can
 * drift on any method nobody wrote a row for, and the action-manifest parity
 * gate only compares what the spines *declare*. These rows close that: each
 * method's declared `RouteAuth` becomes `ConformanceCase` data that
 * `describe_conformance_table_tests` fires at the live gate, in-process and
 * cross-process alike.
 *
 * Rows per method, from its declared auth:
 *
 * - **account or actor required** — `anonymous` → 401
 *   `authentication_required`. The 401 body is method-independent, so every
 *   such row joins one equivalence group: a caller with no credential learns
 *   nothing that tells one method from another.
 * - **credential-gated** (`credential_types`) — each builtin channel the gate
 *   does not admit (`keeper` for `session`, `token` for `api_token`, `daemon`
 *   for `daemon_token`) → 403 `credential_type_required`, echoing the declared
 *   `required_credential_types`. Each of those principals is the keeper.
 * - **role-gated** (`roles`) and admitting a session — `fresh_non_admin` →
 *   403 `insufficient_permissions`, echoing `required_roles`. A role gate
 *   behind a credential gate that refuses sessions is skipped: every
 *   role-less principal would hit the credential gate first.
 * - **public** — no rows.
 *
 * **Acting.** On both spines the authorization phase resolves the acting
 * actor before the credential gate runs, so a keeper with a second actor
 * (`extra_actors`) would answer `actor_required` (400) to a request with no
 * `acting` on an actor-bound method. Every credential and role row on such a
 * method therefore binds `acting` to its principal's own actor at run time
 * (`request.acting: 'principal'`): a single-actor account resolves the same
 * actor with or without it, a multi-actor keeper resolves the one holding its
 * roles, and either way the gate under test is the first that can refuse. The
 * anonymous rows send none — the 401 precedes actor resolution.
 *
 * Every refusal row sends schema-valid params where they can be generated
 * (`generate_valid_body`, its generated `acting` dropped for the binding),
 * so the gate is the only thing that can refuse. A backend
 * whose gate is missing reaches its handler and answers something else. The
 * rows therefore pin each gate, not the gate order against validation — the
 * 401-before-400 rows of the security slate pin that.
 *
 * **Off the declared surface.** `live_rpc_endpoints` adds the methods a
 * backend mounts beyond the declared surface — cell verbs, opt-in resolvers,
 * the `_testing_*` backdoors — read from their action specs the same way, a
 * method the declared surface already has taken from there. The rows then
 * need the same endpoints to resolve: pass them to the table runner's
 * `live_rpc_endpoints` too.
 *
 * Skipped: the protocol actions (`PROTOCOL_ACTION_METHODS`): their auth is
 * fixed by fuz_app's shared specs rather than declared per consumer, they are
 * WebSocket-scoped (`cancel` is a notification with no reply to assert,
 * `peer/ping` is public, `heartbeat` rides an admitted socket), and the WS
 * suites cover them.
 *
 * @module
 */

import type { AppSurfaceSpec, RpcEndpointSpec } from '../../http/surface.ts';
import type { RouteAuth } from '../../http/auth_shape.ts';
import {
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_CREDENTIAL_TYPE_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS
} from '../../http/error_schemas.ts';
import {
	CREDENTIAL_TYPE_API_TOKEN,
	CREDENTIAL_TYPE_DAEMON_TOKEN,
	CREDENTIAL_TYPE_SESSION
} from '../../auth/credential_type_schema.ts';
import { PROTOCOL_ACTION_METHODS } from '../../actions/action_codegen.ts';
import { generate_valid_body } from '../schema_generators.ts';
import type { ConformanceCase, ConformancePrincipal } from './conformance_case.ts';
import type { z } from 'zod';

/**
 * The equivalence group every generated anonymous 401 row joins — the
 * unauthenticated refusal must be byte-identical whatever the method.
 */
export const RPC_AUTH_ANONYMOUS_EQUIVALENCE_GROUP = 'generated_rpc_auth_anonymous_401';

/**
 * The builtin credential channels a conformance principal presents, each the
 * keeper on a different credential. A credential-gated method gets one row per
 * channel its gate refuses.
 */
const CREDENTIAL_PRINCIPALS: ReadonlyArray<{
	readonly as: ConformancePrincipal;
	readonly credential_type: string;
}> = [
	{ as: 'keeper', credential_type: CREDENTIAL_TYPE_SESSION },
	{ as: 'token', credential_type: CREDENTIAL_TYPE_API_TOKEN },
	{ as: 'daemon', credential_type: CREDENTIAL_TYPE_DAEMON_TOKEN }
];

const PROTOCOL_METHODS: ReadonlySet<string> = new Set(PROTOCOL_ACTION_METHODS);

/** Options for `generate_rpc_auth_conformance_cases`. */
export interface RpcAuthConformanceOptions {
	/** The declared surface; its `rpc_endpoints` supply each method's auth and input schema. */
	readonly surface_source: AppSurfaceSpec;
	/**
	 * The endpoints the backend live-mounts, for rows on the methods the
	 * declared surface lacks (resolved — `resolve_rpc_endpoints_for_setup` turns
	 * the factory form into this). Omitted, only declared methods get rows.
	 */
	readonly live_rpc_endpoints?: ReadonlyArray<RpcEndpointSpec>;
	/** Methods to leave out, beyond the protocol actions always skipped. */
	readonly skip_methods?: ReadonlyArray<string>;
}

/**
 * Generate schema-valid params for a method's input, without `acting`.
 *
 * `acting` is read raw by the authorization phase ahead of the gates, so the
 * generator's actor id would answer `actor_not_on_account` instead of the gate
 * under test; the rows bind the principal's real actor instead. A schema the
 * generator can't satisfy sends no params: every gate fires before
 * validation, so the row still pins the gate.
 */
const to_gate_params = (input: z.ZodType): Record<string, unknown> | undefined => {
	let body: Record<string, unknown> | undefined;
	try {
		body = generate_valid_body(input);
	} catch {
		return undefined;
	}
	if (!body) return undefined;
	const { acting: _acting, ...rest } = body;
	return rest;
};

const format_auth = (auth: RouteAuth): string => JSON.stringify(auth);

/**
 * Generate the per-method auth rows for every declared RPC method, then every
 * live-mounted one the declared surface lacks.
 *
 * @param options - the declared surface, the live mount, and any methods to skip
 * @returns the conformance rows, grouped by method in declaration order, then
 *   live-mount order
 */
export const generate_rpc_auth_conformance_cases = (
	options: RpcAuthConformanceOptions
): Array<ConformanceCase> => {
	const skip = new Set(options.skip_methods);
	const seen: Set<string> = new Set();
	const cases: Array<ConformanceCase> = [];
	const endpoints = [
		...options.surface_source.rpc_endpoints,
		...(options.live_rpc_endpoints ?? [])
	];
	for (const endpoint of endpoints) {
		for (const action of endpoint.actions) {
			const { method, auth, input } = action.spec;
			// a live mount repeats the declared methods; the first spec wins
			if (seen.has(method)) continue;
			seen.add(method);
			if (PROTOCOL_METHODS.has(method)) continue;
			if (skip.has(method)) continue;
			const authenticated = auth.account === 'required' || auth.actor === 'required';
			if (!authenticated) continue; // public or identity-optional: no gate refuses a caller
			const params = to_gate_params(input);
			const declared = `declared auth ${format_auth(auth)}`;
			// the actor-bound methods resolve an actor ahead of the gates
			const acting = auth.actor !== 'none' ? ({ acting: 'principal' } as const) : undefined;

			cases.push({
				name: `generated: anonymous → ${method} → 401`,
				request: { method, as: 'anonymous', ...(params && { params }) },
				expect: {
					status: 401,
					error_reason: ERROR_AUTHENTICATION_REQUIRED,
					equivalence_group: RPC_AUTH_ANONYMOUS_EQUIVALENCE_GROUP
				},
				note: `${declared}; the pre-authorization 401 precedes every other gate`
			});

			const credential_types = auth.credential_types;
			if (credential_types?.length) {
				for (const principal of CREDENTIAL_PRINCIPALS) {
					if (credential_types.includes(principal.credential_type)) continue;
					cases.push({
						name: `generated: ${principal.credential_type} → ${method} → 403 credential_type_required`,
						request: { method, as: principal.as, ...acting, ...(params && { params }) },
						expect: {
							status: 403,
							error_reason: ERROR_CREDENTIAL_TYPE_REQUIRED,
							fields: { required_credential_types: [...credential_types] }
						},
						note: `${declared}; the keeper on another channel${acting ? ', acting as its own actor,' : ''} meets the credential gate first`
					});
				}
			}

			const roles = auth.roles;
			const session_admitted = !credential_types?.length
				? true
				: credential_types.includes(CREDENTIAL_TYPE_SESSION);
			if (roles?.length && session_admitted) {
				cases.push({
					name: `generated: fresh non-admin → ${method} → 403 insufficient_permissions`,
					request: { method, as: 'fresh_non_admin', ...acting, ...(params && { params }) },
					expect: {
						status: 403,
						error_reason: ERROR_INSUFFICIENT_PERMISSIONS,
						fields: { required_roles: [...roles] }
					},
					note: `${declared}; a session with no roles clears the credential gate and meets the role gate`
				});
			}
		}
	}
	return cases;
};
