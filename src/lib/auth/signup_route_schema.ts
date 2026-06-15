/**
 * Hono-free wire schemas + route shape for `POST /signup`.
 *
 * Split from `signup_routes.ts` (whose handler pulls `hono/cookie` via
 * `session_middleware` to set the new session cookie) so cross-process test
 * suites can build the signup route shape — and assert on the response shape
 * — without dragging the in-process Hono session handler, and its optional
 * `hono` peer, onto a backend-spawning consumer. `signup_routes.ts` imports
 * these back and attaches the live handler; single source of truth for the
 * wire shape.
 *
 * @module
 */

import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.js';

import {Username, Email} from '../primitive_schemas.js';
import {Password} from './password.js';
import type {RouteSpec} from '../http/route_spec.js';
import {
	ERROR_NO_MATCHING_INVITE,
	ERROR_SIGNUP_CONFLICT,
	ERROR_INVALID_JSON_BODY,
	ERROR_INVALID_REQUEST_BODY,
} from '../http/error_schemas.js';

/** Input for `POST /signup`. `email` is optional (absent or `null` = no email) and must match any referenced invite. */
export const SignupInput = z.strictObject({
	username: Username,
	password: Password,
	email: Email.nullish(),
});
export type SignupInput = z.infer<typeof SignupInput>;

/**
 * Output for `POST /signup`.
 *
 * Session cookie is the operative side effect. The returned `account` and
 * `actor` mirror `BootstrapOutput` so cross-process per-test setup can read
 * the per-test identity straight off the signup response.
 */
export const SignupOutput = z.strictObject({
	ok: z.literal(true),
	account: z.strictObject({id: Uuid, username: Username}),
	actor: z.strictObject({id: Uuid}),
});
export type SignupOutput = z.infer<typeof SignupOutput>;

/** Option inputs that shape the signup route metadata (not its handler). */
export interface SignupRouteShapeOptions {
	/** Whether a per-account signup rate limiter is wired — toggles `rate_limit`. */
	signup_account_rate_limited: boolean;
}

/**
 * The `POST /signup` route shape minus its handler — pure hono-free data.
 * `create_signup_route_specs` spreads this and attaches the live handler;
 * cross-process surface builders spread it with a stub handler. Single source
 * of truth — the shape can't drift between the live route and the surface.
 */
export const create_signup_route_shape = (
	options: SignupRouteShapeOptions,
): Omit<RouteSpec, 'handler'> => ({
	method: 'POST',
	path: '/signup',
	auth: {account: 'none', actor: 'none'},
	description: 'Create account (invite-gated or open signup)',
	transaction: false, // manages its own transaction for TOCTOU safety
	input: SignupInput,
	output: SignupOutput,
	rate_limit: options.signup_account_rate_limited ? 'both' : 'ip',
	errors: {
		400: z.looseObject({
			error: z.enum([ERROR_INVALID_JSON_BODY, ERROR_INVALID_REQUEST_BODY]),
		}),
		403: z.looseObject({error: z.literal(ERROR_NO_MATCHING_INVITE)}),
		409: z.looseObject({error: z.literal(ERROR_SIGNUP_CONFLICT)}),
	},
});
