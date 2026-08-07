/**
 * Bridge functions to derive `RouteSpec` and `EventSpec` from `ActionSpec`.
 *
 * Action specs define the contract (method, input/output, auth, side effects).
 * Bridge functions produce transport-specific specs from them. HTTP-specific
 * concerns (path, handler) come from options.
 *
 * @module
 */

import type { z } from 'zod';

import type { ActionSpec, ActionSideEffects } from './action_spec.ts';
import type { RouteSpec, RouteMethod, RouteHandler } from '../http/route_spec.ts';
import type { RouteAuth } from '../http/auth_shape.ts';
import type { EventSpec } from '../realtime/sse.ts';
import type { RouteErrorSchemas } from '../http/error_schemas.ts';

/** Options for deriving a `RouteSpec` from an `ActionSpec`. */
export interface ActionRouteOptions {
	path: string;
	handler: RouteHandler;
	/** URL path parameter schema. Use `z.strictObject()` with string fields matching `:param` segments. */
	params?: z.ZodObject;
	/** URL query parameter schema. Use `z.strictObject()` with string fields. */
	query?: z.ZodObject;
	/** Override the default HTTP method (default: `side_effects` → POST, else GET). */
	http_method?: RouteMethod;
	/**
	 * Override the route's auth shape — defaults to the action spec's `auth`
	 * (the canonical shape from `http/auth_shape.ts` is shared verbatim between
	 * action specs and route specs, so no mapping is needed).
	 *
	 * This is also the only place a bridged route can declare
	 * `token_surface`, which `ActionSpec.auth` is forbidden to carry — see the
	 * token-scope note on `create_action_route_spec`. Overriding to *widen*
	 * (admitting a credential the action's own gate refused) makes this route
	 * the consumer's to audit, not the spine's.
	 */
	auth?: RouteAuth;
	/** Handler-specific error schemas (HTTP status code → Zod schema). Transport-specific — not on ActionSpec. */
	errors?: RouteErrorSchemas;
}

/** Options for deriving an `EventSpec` from an `ActionSpec`. */
export interface ActionEventOptions {
	channel?: string;
}

/** Derive the default HTTP method from side effects. */
export const derive_http_method = (side_effects: ActionSideEffects): RouteMethod => {
	return side_effects ? 'POST' : 'GET';
};

/**
 * Derive a `RouteSpec` from an `ActionSpec` and options.
 *
 * Only `request_response` actions (which require non-null `auth`) can become routes.
 * `remote_notification` actions (auth null) should use `create_action_event_spec`.
 * `local_call` actions are not for HTTP transport.
 *
 * Error schemas are transport-specific (keyed by HTTP status codes) and belong
 * on the options, not the action spec. Action specs define the contract;
 * transport concerns like HTTP error codes are added at the bridge layer.
 *
 * **A bridged route does not inherit the dispatcher's token-scope gate.** The
 * route runs `options.handler` through the REST pipeline; it never reaches
 * `perform_action`, which is where the per-method scope check lives. So a
 * bridged route is a non-RPC surface, and by token scoping's RPC-only rule a
 * **narrowed** api token should not reach it — but nothing here refuses one,
 * because the auth shape is copied from a spec that is forbidden to declare
 * `token_surface`. If the route is reachable by bearer, decide: pass
 * `options.auth` with a `token_surface` when one of the spine's named surfaces
 * fits, or gate it yourself (read `TOKEN_SCOPE_KEY` and consult
 * `token_scope_admits_non_rpc`). See ../../../docs/security.md §Token scoping.
 *
 * @param spec - the action spec (must have non-null `auth`)
 * @param options - HTTP-specific options (path, handler, optional overrides)
 * @returns a `RouteSpec` ready for `apply_route_specs`
 * @throws Error if `spec.auth` is null (only `request_response` actions can
 *   become routes; notifications and local calls cannot)
 */
export const create_action_route_spec = (
	spec: ActionSpec,
	options: ActionRouteOptions
): RouteSpec => {
	if (spec.auth === null) {
		throw new Error(
			`Cannot derive route spec from action '${
				spec.method
			}': auth is null (only request_response actions with non-null auth can become routes)`
		);
	}
	return {
		method: options.http_method ?? derive_http_method(spec.side_effects),
		path: options.path,
		auth: options.auth ?? spec.auth,
		handler: options.handler,
		description: spec.description,
		...(options.params ? { params: options.params } : {}),
		...(options.query ? { query: options.query } : {}),
		input: spec.input,
		output: spec.output,
		...(options.errors ? { errors: options.errors } : {}),
		transaction: spec.side_effects
	};
};

/**
 * Derive an `EventSpec` from an `ActionSpec`.
 *
 * Only `remote_notification` actions can become push events.
 *
 * @param spec - the action spec (must have `kind: 'remote_notification'`)
 * @param options - optional event-specific options (channel)
 * @returns an `EventSpec` ready for `create_validated_broadcaster`
 * @throws Error if `spec.kind` is not `'remote_notification'`
 */
export const create_action_event_spec = (
	spec: ActionSpec,
	options?: ActionEventOptions
): EventSpec => {
	if (spec.kind !== 'remote_notification') {
		throw new Error(
			`Cannot derive event spec from action '${spec.method}': kind is '${
				spec.kind
			}' (must be 'remote_notification')`
		);
	}
	return {
		method: spec.method,
		params: spec.input,
		description: spec.description,
		channel: options?.channel
	};
};
