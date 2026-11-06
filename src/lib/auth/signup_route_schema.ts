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

import {
	literal,
	loose_object,
	nullable,
	object,
	one_of,
	optional,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

import { Email, Username, UsernameCanonical, Uuid } from '../primitive_schemas_fuz.ts';

import { Password } from './password.ts';
import type { RouteSpec } from '../http/route_spec.ts';
import {
	ERROR_NO_MATCHING_INVITE,
	ERROR_SIGNUP_CONFLICT,
	ERROR_INVALID_JSON_BODY,
	ERROR_INVALID_REQUEST_BODY
} from '../http/error_schemas.ts';

/**
 * Input for `POST /signup`, a `@fuzdev/fuz_schema` schema. `email` is optional
 * (absent or `null` = no email) and must match any referenced invite.
 */
export const SignupInput = object({
	username: Username,
	password: Password,
	email: optional(nullable(Email))
});
export type SignupInput = Infer<typeof SignupInput>;

/**
 * Output for `POST /signup`, a `@fuzdev/fuz_schema` schema.
 *
 * Session cookie is the operative side effect. The returned `account` and
 * `actor` mirror `BootstrapOutput` so cross-process per-test setup can read
 * the per-test identity straight off the signup response. Its `username` is
 * the account row's, `UsernameCanonical`.
 */
export const SignupOutput = object({
	ok: literal(true),
	account: object({ id: Uuid, username: UsernameCanonical }),
	actor: object({ id: Uuid })
});
export type SignupOutput = Infer<typeof SignupOutput>;

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
	options: SignupRouteShapeOptions
): Omit<RouteSpec, 'handler'> => ({
	method: 'POST',
	path: '/signup',
	auth: { account: 'none', actor: 'none' },
	mints_credential: true,
	description: 'Create account (invite-gated or open signup)',
	transaction: false, // manages its own transaction for TOCTOU safety
	input: SignupInput,
	output: SignupOutput,
	rate_limit: options.signup_account_rate_limited ? 'both' : 'ip',
	errors: {
		400: loose_object({ error: one_of([ERROR_INVALID_JSON_BODY, ERROR_INVALID_REQUEST_BODY]) }),
		403: loose_object({ error: literal(ERROR_NO_MATCHING_INVITE) }),
		409: loose_object({ error: literal(ERROR_SIGNUP_CONFLICT) })
	}
});
