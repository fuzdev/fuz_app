/**
 * Hono-free wire shape + schemas for `POST /bootstrap`.
 *
 * Split from `bootstrap_routes.ts` so the route's declared shape (method,
 * path, auth, input/output/error schemas) is importable **without** the
 * hono-coupled handler (which sets a session cookie and reads the client
 * IP off the Hono context). `create_bootstrap_route_specs` attaches the live
 * handler to `bootstrap_route_shape` (`attach_route_handler`); the test surface
 * builder (`create_test_app_surface_spec`) attaches a stub handler so
 * attack-surface generation reads the real shape without pulling the
 * in-process Hono app onto cross-process consumers. Single source of truth —
 * the shape can't drift between the live route and the surface.
 *
 * @module
 */

import { meta } from '@fuzdev/fuz_schema/meta.ts';
import {
	literal,
	max_length,
	min_length,
	object,
	pipe,
	string,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

import { Username, UsernameCanonical, Uuid } from '../primitive_schemas.ts';

import { Password } from './password.ts';
import { define_route_shape } from '../http/route_spec.ts';
import {
	REST_ALREADY_BOOTSTRAPPED,
	REST_INVALID_TOKEN,
	REST_TOKEN_FILE_MISSING
} from '../http/error_schemas.ts';

/**
 * The longest `token` `POST /bootstrap` takes, in UTF-16 code units: the token
 * file's cap, `MAX_SECURE_FILE_SIZE` bytes. A token that can match the file is
 * at most that many bytes in UTF-8, and no more code units than bytes, so the
 * bound refuses none that could match. A longer one is a malformed body, a
 * `400 invalid_request_body` refused before the bootstrap window or the token
 * file is read, with no audit row. Twin of the Rust spine's
 * `BOOTSTRAP_TOKEN_LENGTH_MAX`, which counts the same units.
 */
export const BOOTSTRAP_TOKEN_LENGTH_MAX = 4096;

/**
 * Input for `POST /bootstrap`, a `@fuzdev/fuz_schema` schema. `token` is the
 * one-shot token file contents, 1 to `BOOTSTRAP_TOKEN_LENGTH_MAX` UTF-16 code
 * units.
 */
export const BootstrapInput = object({
	token: meta(pipe(string, min_length(1), max_length(BOOTSTRAP_TOKEN_LENGTH_MAX)), {
		sensitivity: 'secret'
	}),
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
 * `create_bootstrap_route_specs` attaches the live handler to it
 * (`attach_route_handler`); surface generation attaches a stub (handlers are never run
 * during surface assembly, only the shape is read).
 */
export const bootstrap_route_shape = define_route_shape({
	method: 'POST',
	path: '/bootstrap',
	auth: { account: 'none', actor: 'none' },
	mints_credential: true,
	description: 'Create initial keeper account (one-shot)',
	transaction: false, // bootstrap_account manages its own transaction
	input: BootstrapInput,
	output: BootstrapOutput,
	rate_limit: 'ip',
	errors: [REST_INVALID_TOKEN, REST_ALREADY_BOOTSTRAPPED, REST_TOKEN_FILE_MISSING]
});
