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

import {
	array,
	integer,
	literal,
	min_value,
	nullable,
	number,
	object,
	pipe,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

import { ActorSummaryJson, RoleGrantSummaryJson, SessionAccountJson } from './account_schema.ts';
import { UsernameCanonical, UsernameProvided } from '../primitive_schemas_fuz.ts';
import { Password, PasswordProvided } from './password.ts';
import type { RouteSpec } from '../http/route_spec.ts';
import {
	REST_AUTHENTICATION_REQUIRED_BOOTSTRAP,
	REST_INVALID_CREDENTIALS
} from '../http/error_schemas.ts';

/** Input for `GET /api/account/status`, `literal(null)`. No parameters — caller is the subject. */
export const AccountStatusInput = literal(null);
export type AccountStatusInput = Infer<typeof AccountStatusInput>;

/** Output for `GET /api/account/status`, a `@fuzdev/fuz_schema` schema. */
export const AccountStatusOutput = object({
	account: SessionAccountJson,
	actor: nullable(ActorSummaryJson),
	role_grants: array(RoleGrantSummaryJson)
});
export type AccountStatusOutput = Infer<typeof AccountStatusOutput>;

/**
 * Error body for `GET /api/account/status` on the unauthenticated path, a
 * `@fuzdev/fuz_schema` schema: `REST_AUTHENTICATION_REQUIRED_BOOTSTRAP`'s,
 * `authentication_required` with the optional `bootstrap_available`.
 */
export const AccountStatusUnauthenticatedError = REST_AUTHENTICATION_REQUIRED_BOOTSTRAP.schema;
export type AccountStatusUnauthenticatedError = Infer<typeof AccountStatusUnauthenticatedError>;

/**
 * Input for `POST /login`, a `@fuzdev/fuz_schema` schema. Accepts a username
 * or email in the `username` field.
 */
export const LoginInput = object({
	username: UsernameProvided,
	password: PasswordProvided
});
export type LoginInput = Infer<typeof LoginInput>;

/**
 * Output for `POST /login`, a `@fuzdev/fuz_schema` schema. Session cookie is
 * the operative side effect.
 */
export const LoginOutput = object({
	ok: literal(true)
});
export type LoginOutput = Infer<typeof LoginOutput>;

/** Input for `POST /logout`, `literal(null)`. Session identity flows through the cookie. */
export const LogoutInput = literal(null);
export type LogoutInput = Infer<typeof LogoutInput>;

/**
 * Output for `POST /logout`, a `@fuzdev/fuz_schema` schema. Includes the
 * revoked account's username for UI redraw, as the account row holds it.
 */
export const LogoutOutput = object({
	ok: literal(true),
	username: UsernameCanonical
});
export type LogoutOutput = Infer<typeof LogoutOutput>;

/**
 * Input for `POST /password`, a `@fuzdev/fuz_schema` schema.
 * `current_password` is minimally validated; `new_password` enforces the full
 * policy.
 */
export const PasswordChangeInput = object({
	current_password: PasswordProvided,
	new_password: Password
});
export type PasswordChangeInput = Infer<typeof PasswordChangeInput>;

/**
 * Output for `POST /password`, a `@fuzdev/fuz_schema` schema. Counts are
 * returned so the UI can summarize the revoke-all cascade.
 */
export const PasswordChangeOutput = object({
	ok: literal(true),
	sessions_revoked: pipe(number, integer, min_value(0)),
	tokens_revoked: pipe(number, integer, min_value(0))
});
export type PasswordChangeOutput = Infer<typeof PasswordChangeOutput>;

/**
 * Default maximum sessions per account.
 *
 * The Rust twin pins the same 5 as a `const` (`fuz_auth`'s
 * `DEFAULT_MAX_SESSIONS`) rather than a route-state field, because its
 * `AccountRouteState` has no `Default` and a new field would break every
 * exhaustive literal in every consumer workspace. So this stays the
 * configurable side of the pair (`null` disables), and the two ship the same
 * number — retuning means editing both.
 */
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
	auth: { account: 'none', actor: 'none' },
	// no gate — the handler answers an anonymous caller with its own 401 — but
	// it reads the account the auth middleware resolved
	reads_credential: true,
	description: 'Current account info (unauthenticated: 401 with bootstrap status)',
	input: AccountStatusInput,
	output: AccountStatusOutput,
	errors: [REST_AUTHENTICATION_REQUIRED_BOOTSTRAP]
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
	options: AccountRouteShapeOptions
): [
	Omit<RouteSpec, 'handler'>,
	Omit<RouteSpec, 'handler'>,
	Omit<RouteSpec, 'handler'>,
	Omit<RouteSpec, 'handler'>
] => [
	{
		method: 'GET',
		path: '/verify',
		// a non-RPC surface: the probe answers 200 for the account behind a
		// credential, so a narrowed token is refused it (it would otherwise pass
		// an nginx `auth_request` gate as its account)
		auth: {
			account: 'required',
			actor: 'none',
			required_scope: 'surface:account_verify'
		},
		description:
			'Session-validity probe for nginx auth_request (empty body; 200, 401, or 403 for a narrowed token)',
		input: literal(null),
		output: literal(null)
	},
	{
		method: 'POST',
		path: '/login',
		auth: { account: 'none', actor: 'none' },
		mints_credential: true,
		description: 'Exchange credentials for session',
		input: LoginInput,
		output: LoginOutput,
		rate_limit: 'both',
		// The handler opens its own transaction around just the session writes,
		// so a reservation waiting for a slot, and the Argon2 verify, hold no
		// database connection.
		transaction: false,
		errors: [REST_INVALID_CREDENTIALS]
	},
	{
		method: 'POST',
		path: '/logout',
		// `credential_types: ['session']` — see `docs/security.md` §Credential-channel gating.
		// Logout is a session-bound operation; a bearer / daemon token holds no session
		// to end, so the dispatcher rejects it (403 `credential_type_required`) rather than
		// returning a misleading 200 + a phantom `logout` audit row for a no-op.
		auth: { account: 'required', actor: 'none', credential_types: ['session'] },
		description: 'Revoke current session and clear cookie',
		input: LogoutInput,
		output: LogoutOutput
	},
	{
		method: 'POST',
		path: '/password',
		// `credential_types: ['session']` — see `docs/security.md` §Credential-channel gating.
		auth: { account: 'required', actor: 'none', credential_types: ['session'] },
		description: 'Change password (revokes all sessions and API tokens)',
		input: PasswordChangeInput,
		output: PasswordChangeOutput,
		rate_limit: options.login_account_rate_limited ? 'both' : 'ip',
		// The handler opens its own transaction around just the password update
		// and the revocations, so a reservation waiting for a slot, and the
		// Argon2 verify and hash, hold no database connection.
		transaction: false,
		// a wrong current password answers `invalid_credentials`, as login does
		errors: [REST_INVALID_CREDENTIALS]
	}
];
