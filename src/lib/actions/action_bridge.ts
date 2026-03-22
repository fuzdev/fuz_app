/**
 * Bridge functions to derive `RouteSpec` and `SseEventSpec` from `ActionSpec`.
 *
 * Action specs define the contract (method, input/output, auth, side effects).
 * Bridge functions produce transport-specific specs from them. HTTP-specific
 * concerns (path, handler) come from options.
 *
 * @module
 */

import type {z} from 'zod';

import type {ActionSpec, ActionAuth as ActionSpecAuth, ActionSideEffects} from './action_spec.js';
import type {RouteSpec, RouteAuth, RouteMethod, RouteHandler} from '../http/route_spec.js';
import type {SseEventSpec} from '../realtime/sse.js';
import type {RouteErrorSchemas} from '../http/error_schemas.js';

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
	/** Override the default auth mapping (default: `'public'` → none, `'authenticated'` → authenticated, `'keeper'` → keeper, `{role}` → role). */
	auth?: RouteAuth;
	/** Handler-specific error schemas (HTTP status code → Zod schema). Transport-specific — not on ActionSpec. */
	errors?: RouteErrorSchemas;
}

/** Options for deriving an `SseEventSpec` from an `ActionSpec`. */
export interface ActionEventOptions {
	channel?: string;
}

/** Map an `ActionAuth` value to a `RouteAuth`. */
export const map_action_auth = (auth: ActionSpecAuth): RouteAuth => {
	if (auth === 'public') return {type: 'none'};
	if (auth === 'authenticated') return {type: 'authenticated'};
	if (auth === 'keeper') return {type: 'keeper'};
	return {type: 'role', role: auth.role};
};

/** Derive the default HTTP method from side effects. */
export const derive_http_method = (side_effects: ActionSideEffects): RouteMethod => {
	return side_effects === true ? 'POST' : 'GET';
};

/**
 * Derive a `RouteSpec` from an `ActionSpec` and options.
 *
 * Only `request_response` actions (which require non-null `auth`) can become routes.
 * `remote_notification` actions (auth null) should use `event_spec_from_action`.
 * `local_call` actions are not for HTTP transport.
 *
 * Error schemas are transport-specific (keyed by HTTP status codes) and belong
 * on the options, not the action spec. Action specs define the contract;
 * transport concerns like HTTP error codes are added at the bridge layer.
 *
 * @param spec - the action spec (must have non-null `auth`)
 * @param options - HTTP-specific options (path, handler, optional overrides)
 * @returns a `RouteSpec` ready for `apply_route_specs`
 * @throws if `spec.auth` is null
 */
export const route_spec_from_action = (
	spec: ActionSpec,
	options: ActionRouteOptions,
): RouteSpec => {
	if (spec.auth === null) {
		throw new Error(
			`Cannot derive route spec from action '${spec.method}': auth is null (only request_response actions with non-null auth can become routes)`,
		);
	}
	return {
		method: options.http_method ?? derive_http_method(spec.side_effects),
		path: options.path,
		auth: options.auth ?? map_action_auth(spec.auth),
		handler: options.handler,
		description: spec.description,
		...(options.params ? {params: options.params} : {}),
		...(options.query ? {query: options.query} : {}),
		input: spec.input,
		output: spec.output,
		...(options.errors ? {errors: options.errors} : {}),
	};
};

/**
 * Derive an `SseEventSpec` from an `ActionSpec`.
 *
 * Only `remote_notification` actions can become SSE events.
 *
 * @param spec - the action spec (must have `kind: 'remote_notification'`)
 * @param options - optional SSE-specific options (channel)
 * @returns an `SseEventSpec` ready for `create_validated_broadcaster`
 */
export const event_spec_from_action = (
	spec: ActionSpec,
	options?: ActionEventOptions,
): SseEventSpec => {
	if (spec.kind !== 'remote_notification') {
		throw new Error(
			`Cannot derive event spec from action '${spec.method}': kind is '${spec.kind}' (must be 'remote_notification')`,
		);
	}
	return {
		method: spec.method,
		params: spec.input,
		description: spec.description,
		channel: options?.channel,
	};
};
