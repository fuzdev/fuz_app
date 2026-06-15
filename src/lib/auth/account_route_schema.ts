/**
 * Hono-free wire schemas + route shapes for the account REST routes.
 *
 * Split from `account_routes.ts` (whose handlers pull `hono/cookie` via
 * `session_middleware`) so cross-process test suites can build the account
 * route shapes — and assert on the `POST /login` / `GET /api/account/status`
 * response shapes — without dragging the in-process Hono session handler, and
 * its optional `hono` peer, onto a backend-spawning consumer. `account_routes.ts`
 * imports these back and attaches the live handlers; single source of truth
 * for the wire shape.
 *
 * @module
 */

import {z} from 'zod';

import {ActorSummaryJson, RoleGrantSummaryJson, SessionAccountJson} from './account_schema.js';
import {UsernameProvided} from '../primitive_schemas.js';
import {Password, PasswordProvided} from './password.js';
import type {RouteSpec} from '../http/route_spec.js';
import {
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INVALID_CREDENTIALS,
	ERROR_INVALID_JSON_BODY,
	ERROR_INVALID_REQUEST_BODY,
} from '../http/error_schemas.js';

/** Input for `GET /api/account/status`. No parameters — caller is the subject. */
export const AccountStatusInput = z.null();
export type AccountStatusInput = z.infer<typeof AccountStatusInput>;

/** Output for `GET /api/account/status`. */
export const AccountStatusOutput = z.strictObject({
	account: SessionAccountJson,
	actor: ActorSummaryJson.nullable(),
	role_grants: z.array(RoleGrantSummaryJson),
});
export type AccountStatusOutput = z.infer<typeof AccountStatusOutput>;

/** Error body for `GET /api/account/status` on the unauthenticated path. */
export const AccountStatusUnauthenticatedError = z.looseObject({
	error: z.literal(ERROR_AUTHENTICATION_REQUIRED),
	bootstrap_available: z.boolean().optional(),
});
export type AccountStatusUnauthenticatedError = z.infer<typeof AccountStatusUnauthenticatedError>;

/** Input for `POST /login`. Accepts a username or email in the `username` field. */
export const LoginInput = z.strictObject({
	username: UsernameProvided,
	password: PasswordProvided,
});
export type LoginInput = z.infer<typeof LoginInput>;

/** Output for `POST /login`. Session cookie is the operative side effect. */
export const LoginOutput = z.strictObject({
	ok: z.literal(true),
});
export type LoginOutput = z.infer<typeof LoginOutput>;

/** Input for `POST /logout`. Session identity flows through the cookie. */
export const LogoutInput = z.null();
export type LogoutInput = z.infer<typeof LogoutInput>;

/** Output for `POST /logout`. Includes the revoked account's username for UI redraw. */
export const LogoutOutput = z.strictObject({
	ok: z.literal(true),
	username: z.string(),
});
export type LogoutOutput = z.infer<typeof LogoutOutput>;

/** Input for `POST /password`. `current_password` is minimally validated; `new_password` enforces the full policy. */
export const PasswordChangeInput = z.strictObject({
	current_password: PasswordProvided,
	new_password: Password,
});
export type PasswordChangeInput = z.infer<typeof PasswordChangeInput>;

/** Output for `POST /password`. Counts are returned so the UI can summarize the revoke-all cascade. */
export const PasswordChangeOutput = z.strictObject({
	ok: z.literal(true),
	sessions_revoked: z.number(),
	tokens_revoked: z.number(),
});
export type PasswordChangeOutput = z.infer<typeof PasswordChangeOutput>;

/** Default maximum sessions per account. */
export const DEFAULT_MAX_SESSIONS = 5;

/** Default maximum API tokens per account. */
export const DEFAULT_MAX_TOKENS = 10;

/**
 * The `GET /status` route shape minus its handler — pure hono-free data.
 * `create_account_status_route_spec` spreads this and attaches the live handler
 * (which reads the account id off the request context); surface generation
 * spreads it with a stub handler.
 *
 * The path is **relative** like the sibling account shapes (`/login`,
 * `/verify`), so it composes under `prefix_route_specs('/api/account', …)` into
 * `/api/account/status`. `create_account_route_specs` bundles it (so every
 * account surface serves `/status`, matching the Rust `account_router`);
 * mirror Rust by mounting it as part of the account family, not separately.
 */
export const account_status_route_shape = {
	method: 'GET',
	path: '/status',
	auth: {account: 'none', actor: 'none'},
	description: 'Current account info (unauthenticated: 401 with bootstrap status)',
	input: AccountStatusInput,
	output: AccountStatusOutput,
	errors: {
		401: AccountStatusUnauthenticatedError,
	},
} satisfies Omit<RouteSpec, 'handler'>;

/** Option inputs that shape the account route metadata (not its handlers). */
export interface AccountRouteShapeOptions {
	/** Whether a per-account login rate limiter is wired — toggles `/password`'s `rate_limit`. */
	login_account_rate_limited: boolean;
}

/**
 * The four account route shapes (`/verify`, `/login`, `/logout`, `/password`)
 * minus their handlers — pure hono-free data. `create_account_route_specs`
 * spreads each and attaches the live handler; cross-process surface builders
 * spread them with stub handlers. Single source of truth — the shapes can't
 * drift between the live routes and the surface.
 *
 * Returns a fixed 4-tuple `[verify, login, logout, password]` so destructuring
 * yields non-optional shapes under `noUncheckedIndexedAccess`.
 */
export const create_account_route_shapes = (
	options: AccountRouteShapeOptions,
): [
	Omit<RouteSpec, 'handler'>,
	Omit<RouteSpec, 'handler'>,
	Omit<RouteSpec, 'handler'>,
	Omit<RouteSpec, 'handler'>,
] => [
	{
		method: 'GET',
		path: '/verify',
		auth: {account: 'required', actor: 'none'},
		description: 'Session-validity probe for nginx auth_request (empty body, 200 or 401)',
		input: z.null(),
		output: z.null(),
	},
	{
		method: 'POST',
		path: '/login',
		auth: {account: 'none', actor: 'none'},
		description: 'Exchange credentials for session',
		input: LoginInput,
		output: LoginOutput,
		rate_limit: 'both',
		errors: {
			400: z.looseObject({
				error: z.enum([ERROR_INVALID_JSON_BODY, ERROR_INVALID_REQUEST_BODY]),
			}),
			401: z.looseObject({error: z.literal(ERROR_INVALID_CREDENTIALS)}),
		},
	},
	{
		method: 'POST',
		path: '/logout',
		// `credential_types: ['session']` — see `docs/security.md` §Credential-channel gating.
		// Logout is a session-bound operation; a bearer / daemon token holds no session
		// to end, so the dispatcher rejects it (403 `credential_type_required`) rather than
		// returning a misleading 200 + a phantom `logout` audit row for a no-op.
		auth: {account: 'required', actor: 'none', credential_types: ['session']},
		description: 'Revoke current session and clear cookie',
		input: LogoutInput,
		output: LogoutOutput,
	},
	{
		method: 'POST',
		path: '/password',
		// `credential_types: ['session']` — see `docs/security.md` §Credential-channel gating.
		auth: {account: 'required', actor: 'none', credential_types: ['session']},
		description: 'Change password (revokes all sessions and API tokens)',
		input: PasswordChangeInput,
		output: PasswordChangeOutput,
		rate_limit: options.login_account_rate_limited ? 'both' : 'ip',
		errors: {
			400: z.looseObject({
				error: z.enum([ERROR_INVALID_JSON_BODY, ERROR_INVALID_REQUEST_BODY]),
			}),
		},
	},
];
