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

import { z } from 'zod';
import { Uuid } from '@fuzdev/fuz_util/id.ts';

import { Username } from '../primitive_schemas.ts';
import { Password } from './password.ts';
import type { RouteSpec } from '../http/route_spec.ts';
import {
	ERROR_INVALID_TOKEN,
	ERROR_ALREADY_BOOTSTRAPPED,
	ERROR_TOKEN_FILE_MISSING,
	ERROR_INVALID_JSON_BODY,
	ERROR_INVALID_REQUEST_BODY
} from '../http/error_schemas.ts';

/** Input for `POST /bootstrap`. `token` is the one-shot token file contents. */
export const BootstrapInput = z.strictObject({
	token: z.string().min(1).meta({ sensitivity: 'secret' }),
	username: Username,
	password: Password
});
export type BootstrapInput = z.infer<typeof BootstrapInput>;

/** Output for `POST /bootstrap`. Session cookie is the operative side effect. */
export const BootstrapOutput = z.strictObject({
	ok: z.literal(true),
	account: z.strictObject({ id: Uuid, username: Username }),
	actor: z.strictObject({ id: Uuid })
});
export type BootstrapOutput = z.infer<typeof BootstrapOutput>;

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
	description: 'Create initial keeper account (one-shot)',
	transaction: false, // bootstrap_account manages its own transaction
	input: BootstrapInput,
	output: BootstrapOutput,
	rate_limit: 'ip',
	errors: {
		400: z.looseObject({
			error: z.enum([ERROR_INVALID_JSON_BODY, ERROR_INVALID_REQUEST_BODY])
		}),
		401: z.looseObject({ error: z.literal(ERROR_INVALID_TOKEN) }),
		403: z.looseObject({ error: z.literal(ERROR_ALREADY_BOOTSTRAPPED) }),
		404: z.looseObject({ error: z.literal(ERROR_TOKEN_FILE_MISSING) })
	}
} satisfies Omit<RouteSpec, 'handler'>;
