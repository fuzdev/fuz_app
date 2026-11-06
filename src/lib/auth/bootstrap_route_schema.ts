/**
 * Hono-free wire shape + schemas for `POST /bootstrap`.
 *
 * Split from `bootstrap_routes.ts` so the route's declared shape (method,
 * path, auth, input/output/error schemas) is importable **without** the
 * hono-coupled handler (which sets a session cookie and reads the client
 * IP off the Hono context). `create_bootstrap_route_specs` spreads
 * `bootstrap_route_shape` and attaches the live handler; the test surface
 * builder (`create_test_app_surface_spec`) spreads it with a stub handler so
 * attack-surface generation reads the real shape without pulling the
 * in-process Hono app onto cross-process consumers. Single source of truth —
 * the shape can't drift between the live route and the surface.
 *
 * @module
 */

import { meta } from '@fuzdev/fuz_schema/meta.ts';
import {
	literal,
	loose_object,
	min_length,
	object,
	one_of,
	pipe,
	string,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

import { Username, UsernameCanonical, Uuid } from '../primitive_schemas_fuz.ts';

import { Password } from './password.ts';
import type { RouteSpec } from '../http/route_spec.ts';
import {
	ERROR_INVALID_TOKEN,
	ERROR_ALREADY_BOOTSTRAPPED,
	ERROR_TOKEN_FILE_MISSING,
	ERROR_INVALID_JSON_BODY,
	ERROR_INVALID_REQUEST_BODY
} from '../http/error_schemas.ts';

/**
 * Input for `POST /bootstrap`, a `@fuzdev/fuz_schema` schema. `token` is the
 * one-shot token file contents.
 */
export const BootstrapInput = object({
	token: meta(pipe(string, min_length(1)), { sensitivity: 'secret' }),
	username: Username,
	password: Password
});
export type BootstrapInput = Infer<typeof BootstrapInput>;

/**
 * Output for `POST /bootstrap`, a `@fuzdev/fuz_schema` schema. Session cookie
 * is the operative side effect. Its `username` is the account row's,
 * `UsernameCanonical`.
 */
export const BootstrapOutput = object({
	ok: literal(true),
	account: object({ id: Uuid, username: UsernameCanonical }),
	actor: object({ id: Uuid })
});
export type BootstrapOutput = Infer<typeof BootstrapOutput>;

/**
 * The `POST /bootstrap` route shape minus its handler — pure hono-free data.
 * `create_bootstrap_route_specs` spreads this and attaches the live handler;
 * surface generation spreads it with a stub handler (handlers are never run
 * during surface assembly, only the shape is read).
 */
export const bootstrap_route_shape = {
	method: 'POST',
	path: '/bootstrap',
	auth: { account: 'none', actor: 'none' },
	mints_credential: true,
	description: 'Create initial keeper account (one-shot)',
	transaction: false, // bootstrap_account manages its own transaction
	input: BootstrapInput,
	output: BootstrapOutput,
	rate_limit: 'ip',
	errors: {
		400: loose_object({ error: one_of([ERROR_INVALID_JSON_BODY, ERROR_INVALID_REQUEST_BODY]) }),
		401: loose_object({ error: literal(ERROR_INVALID_TOKEN) }),
		403: loose_object({ error: literal(ERROR_ALREADY_BOOTSTRAPPED) }),
		404: loose_object({ error: literal(ERROR_TOKEN_FILE_MISSING) })
	}
} satisfies Omit<RouteSpec, 'handler'>;
