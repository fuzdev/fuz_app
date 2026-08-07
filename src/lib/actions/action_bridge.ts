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
import { token_scope_method_capability } from '../auth/token_scope.ts';
import type { RouteSpec, RouteMethod, RouteHandler } from '../http/route_spec.ts';
import { is_public_auth, type RouteAuth } from '../http/auth_shape.ts';
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
	 * The bridge fills in `required_scope` on whichever shape it ends up with,
	 * so an override still gets the token-scope gate; declare `required_scope`
	 * here to name a different capability (e.g. `surface:<name>` when the
	 * bridged route is a stream rather than a request/response call — see the
	 * token-scope note on `create_action_route_spec`).
	 *
	 * Overriding to *widen* (admitting a credential the action's own gate
	 * refused) makes this route the consumer's to audit, not the spine's.
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
 * **The bridge carries the token-scope gate across for you.** A bridged route
 * runs `options.handler` through the REST pipeline and never reaches
 * `perform_action`, so the dispatcher's per-method scope check cannot fire on
 * it — which would leave a bearer-reachable route that a **narrowed** api token
 * walks straight through. So the derived spec declares
 * `auth.required_scope: 'rpc:<method>'`, and `fuz_auth_guard_resolver` mounts
 * the same refusal ahead of the role gate. A token that lists the method
 * reaches the bridged route; one that doesn't gets the 403 it would have gotten
 * over RPC.
 *
 * Per-method rather than rule 3's blanket refusal because a bridged route
 * *has* a method identity — which is exactly what the non-RPC surfaces rule 3
 * covers (the db browser, a bare-hash read, a stream) do not, and why that rule
 * is all-or-nothing there. **Bridge something with no request/response shape —
 * an SSE stream, a file download — and rule 3's reasoning applies instead**:
 * pass `options.auth` with `required_scope: 'surface:<name>'`, naming your own
 * surface. See `docs/security.md` §Token scoping.
 *
 * Skipped for a public action (`account: 'none', actor: 'none'`), where the
 * same holder reaches the route by dropping the credential, so the guard would
 * enforce nothing — the shape `fuz_auth_guard_resolver` refuses outright.
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
	const auth = options.auth ?? spec.auth;
	// Carry the dispatcher's per-method scope gate across — see the token-scope
	// note above. An explicit capability wins; a public route has no credential
	// to narrow, and the resolver rejects the gate on that shape anyway.
	const derives_scope_gate = auth.required_scope === undefined && !is_public_auth(auth);
	return {
		method: options.http_method ?? derive_http_method(spec.side_effects),
		path: options.path,
		auth: derives_scope_gate
			? { ...auth, required_scope: token_scope_method_capability(spec.method) }
			: auth,
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
