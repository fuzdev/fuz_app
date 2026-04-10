/**
 * RPC-style route spec derivation from action specs.
 *
 * `create_rpc_route_specs` produces `RouteSpec[]` from action specs with
 * RPC handlers — pure data derivation, no side effects. Consumers compose
 * with other route specs in their `create_route_specs` callback.
 *
 * Handler signature: `(input: TInput, ctx: ActionContext) => TOutput`
 * where `ActionContext` provides auth identity, DB, and framework context.
 *
 * TODO @action-system-review This module will evolve with the saes-rpc quest.
 * Phase 2 migrates tx consumers to RPC handlers; Phase 3 adds client generation.
 *
 * @module
 */

import type {Context} from 'hono';
import type {Logger} from '@fuzdev/fuz_util/log.js';

import type {RequestResponseActionSpec} from './action_spec.js';
import {map_action_auth} from './action_bridge.js';
import {get_route_input, type RouteContext, type RouteSpec} from '../http/route_spec.js';
import {get_request_context, type RequestContext} from '../auth/request_context.js';
import type {Db} from '../db/db.js';
import {is_null_schema} from '../http/schema_helpers.js';
import {ERROR_INVALID_JSON_BODY, ERROR_INVALID_REQUEST_BODY} from '../http/error_schemas.js';

/**
 * Per-request context provided to RPC action handlers.
 *
 * Extends `RouteContext` with auth identity and logger.
 * `auth` is `RequestContext | null` — handlers for authenticated
 * actions can narrow via the auth middleware guarantee.
 */
export interface ActionContext {
	/** The authenticated identity, or `null` for public routes. */
	auth: RequestContext | null;
	/** Transaction-scoped for mutations, pool-level for reads. */
	db: Db;
	/** Always pool-level — for fire-and-forget effects that outlive the transaction. */
	background_db: Db;
	/** Fire-and-forget side effects — push here for post-response flushing. */
	pending_effects: Array<Promise<void>>;
	/** Logger instance. */
	log: Logger;
}

/**
 * Handler function for an RPC action.
 *
 * Receives validated input and an `ActionContext` with per-request deps.
 * Returns the output value (serialized to JSON by the wrapper).
 */
export type ActionHandler<TInput = any, TOutput = any> = (
	input: TInput,
	ctx: ActionContext,
) => TOutput | Promise<TOutput>;

/**
 * An RPC action — combines an action spec with its handler.
 *
 * The spec defines the contract (method, auth, schemas, side effects).
 * The handler implements the behavior.
 */
export interface RpcAction {
	spec: RequestResponseActionSpec;
	handler: ActionHandler;
}

/** Options for `create_rpc_route_specs`. */
export interface CreateRpcRouteSpecsOptions {
	/** Mount path prefix for all RPC routes (e.g., `/api/rpc`). */
	path: string;
	/** RPC actions to derive routes from. */
	actions: Array<RpcAction>;
	/** Logger instance for handler context. */
	log: Logger;
}

/**
 * Derive `RouteSpec[]` from RPC actions — pure data, no side effects.
 *
 * For each action, produces a `RouteSpec` with:
 * - Method: `side_effects === false` → GET, else POST
 * - Path: `{mount}/{spec.method}`
 * - Auth: derived via `map_action_auth`
 * - Transaction: from `spec.side_effects` (semantic truth)
 * - Handler wrapper that constructs `ActionContext` and delegates to the action handler
 *
 * GET input handling:
 * - Null input schema → passes `null` directly
 * - Real input schema → parses `?params=` query string as JSON, validates against schema
 *
 * POST input comes from the validated body (existing `apply_route_specs` middleware).
 *
 * @param options - mount path, actions, and logger
 * @returns route specs ready for `apply_route_specs`
 */
export const create_rpc_route_specs = (options: CreateRpcRouteSpecsOptions): Array<RouteSpec> => {
	const {path: mount, actions, log} = options;
	return actions.map(({spec, handler}): RouteSpec => {
		const method = spec.side_effects ? 'POST' : 'GET';
		const route_path = `${mount}/${spec.method}`;

		const route_handler = async (c: Context, route: RouteContext): Promise<Response> => {
			// resolve input based on HTTP method
			let input: unknown;
			if (method === 'POST') {
				input = get_route_input(c);
			} else if (is_null_schema(spec.input)) {
				input = null;
			} else {
				// GET with real input — parse from ?params= query string
				const params_raw = c.req.query('params');
				if (params_raw === undefined) {
					return c.json(
						{
							error: ERROR_INVALID_REQUEST_BODY,
							issues: [{message: 'missing params query parameter'}],
						},
						400,
					);
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(params_raw);
				} catch {
					return c.json({error: ERROR_INVALID_JSON_BODY}, 400);
				}
				const result = spec.input.safeParse(parsed);
				if (!result.success) {
					return c.json({error: ERROR_INVALID_REQUEST_BODY, issues: result.error.issues}, 400);
				}
				input = result.data;
			}

			// construct ActionContext
			const action_context: ActionContext = {
				auth: get_request_context(c),
				db: route.db,
				background_db: route.background_db,
				pending_effects: route.pending_effects,
				log,
			};

			const output = await handler(input, action_context);
			return c.json(output);
		};

		return {
			method,
			path: route_path,
			auth: map_action_auth(spec.auth),
			handler: route_handler,
			description: spec.description,
			input: spec.input,
			output: spec.output,
			transaction: spec.side_effects,
		};
	});
};
