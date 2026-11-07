/**
 * The account routes' surface — `/verify`, `/login`, `/logout`, `/password`,
 * `/status`, `/signup` and `/bootstrap` — held to the one captured in
 * `fixtures/surface/account_routes.json`. Equal as JSON apart from the
 * declared moves, each applied to the capture here:
 *
 * - `/login`'s `username` is `UsernameProvided`, whose refusal of a
 *   whitespace-only string is a `regex(/\S/)`, a `pattern`, where the captured one
 *   refined the trimmed string
 * - the output `username` of `/logout`, `/signup` and `/bootstrap` is
 *   `UsernameCanonical`, its bounds and lowercase grammar, where the captured one
 *   was a plain string (`/logout`) or the creation `Username`, whose transform
 *   has no JSON Schema form (`{}`, and an `info` diagnostic on the output)
 * - `/password`'s revoke counts are non-negative integers, where the captured
 *   ones were any number
 * - `/signup`'s `email` gains `maxLength`, the `max_length` the fuz_schema
 *   `Email` bounds its code units by ahead of its byte `check`, which has no
 *   JSON Schema form, an `info` diagnostic on the input
 * - `/bootstrap`'s `token` gains `maxLength`, `BOOTSTRAP_TOKEN_LENGTH_MAX`,
 *   the token file's cap, where the captured one had no maximum
 *
 * The error schemas are the capture's but for the moves of the error rules,
 * `ERROR_MOVES`: the body 400 is the two body definitions, derived for each
 * route with a body (the routes declared it as one enum of the two codes);
 * the derived 401 is `authentication_required` exactly (it was any string);
 * `/password` declares the `invalid_credentials` 401 its handler answers,
 * beside the derived one; and the rate limit's `retry_after` is a
 * non-negative integer (it was any number).
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { readFileSync } from 'node:fs';

import {
	account_status_route_shape,
	create_account_route_shapes
} from '#lib/auth/account_route_schema.ts';
import { create_signup_route_shape } from '#lib/auth/signup_route_schema.ts';
import {
	BOOTSTRAP_TOKEN_LENGTH_MAX,
	bootstrap_route_shape
} from '#lib/auth/bootstrap_route_schema.ts';
import { generate_app_surface, type AppSurfaceDiagnostic } from '#lib/http/surface.ts';
import type { RouteSpec } from '#lib/http/route_spec.ts';
import { stub_route_spec } from '#lib/testing/stubs.ts';
import {
	EMAIL_LENGTH_MAX,
	USERNAME_LENGTH_MAX,
	USERNAME_LENGTH_MIN,
	USERNAME_CANONICAL_REGEX
} from '#lib/primitive_schemas.ts';
import {
	REST_AUTHENTICATION_REQUIRED,
	REST_INVALID_CREDENTIALS,
	REST_INVALID_JSON_BODY,
	REST_INVALID_REQUEST_BODY,
	REST_RATE_LIMIT_EXCEEDED
} from '#lib/http/error_schemas.ts';
import { with_error_moves, type ErrorMove } from '../surface_test_helpers.ts';

const FIXTURE_PATH = new URL('../fixtures/surface/account_routes.json', import.meta.url);

interface SurfaceCapture {
	routes: Array<Record<string, any>>;
	diagnostics: Array<AppSurfaceDiagnostic>;
}

const capture_surface = () => {
	const route_specs: Array<RouteSpec> = [
		...create_account_route_shapes({ login_account_rate_limited: true }),
		account_status_route_shape,
		create_signup_route_shape({ signup_account_rate_limited: true }),
		bootstrap_route_shape
	].map((shape) => stub_route_spec(shape));
	return generate_app_surface({ route_specs, middleware_specs: [] });
};

const USERNAME_NODE = {
	type: 'string',
	minLength: USERNAME_LENGTH_MIN,
	maxLength: USERNAME_LENGTH_MAX,
	pattern: USERNAME_CANONICAL_REGEX.source
};
const COUNT_NODE = { type: 'integer', minimum: 0 };

const with_properties = (
	node: Record<string, any>,
	properties: Record<string, unknown>
): Record<string, any> => ({ ...node, properties: { ...node.properties, ...properties } });

// the declared moves of one route, by `METHOD path`
const MOVES: Record<string, (route: Record<string, any>) => Record<string, any>> = {
	'POST /login': (route) => {
		const { username } = route.input_schema.properties;
		assert.deepStrictEqual(username, { type: 'string', minLength: 1, maxLength: 255 });
		return {
			...route,
			input_schema: with_properties(route.input_schema, {
				username: { ...username, pattern: '\\S' }
			})
		};
	},
	'POST /logout': (route) => {
		assert.deepStrictEqual(route.output_schema.properties.username, { type: 'string' });
		return {
			...route,
			output_schema: with_properties(route.output_schema, { username: USERNAME_NODE })
		};
	},
	'POST /password': (route) => {
		const { properties } = route.output_schema;
		assert.deepStrictEqual(properties.sessions_revoked, { type: 'number' });
		assert.deepStrictEqual(properties.tokens_revoked, { type: 'number' });
		return {
			...route,
			output_schema: with_properties(route.output_schema, {
				sessions_revoked: COUNT_NODE,
				tokens_revoked: COUNT_NODE
			})
		};
	},
	'POST /signup': (route) => {
		const { email } = route.input_schema.properties;
		const [string_node, ...rest] = email.anyOf;
		return with_output_username({
			...route,
			input_schema: with_properties(route.input_schema, {
				email: { ...email, anyOf: [{ ...string_node, maxLength: EMAIL_LENGTH_MAX }, ...rest] }
			})
		});
	},
	'POST /bootstrap': (route) => {
		const { token } = route.input_schema.properties;
		assert.deepStrictEqual(token, { type: 'string', minLength: 1, sensitivity: 'secret' });
		return with_output_username({
			...route,
			input_schema: with_properties(route.input_schema, {
				token: { ...token, maxLength: BOOTSTRAP_TOKEN_LENGTH_MAX }
			})
		});
	}
};

// declared: the output account's `username`, `{}` at capture, is `UsernameCanonical`
const with_output_username = (route: Record<string, any>): Record<string, any> => {
	const { account } = route.output_schema.properties;
	assert.deepStrictEqual(account.properties.username, {});
	return {
		...route,
		output_schema: with_properties(route.output_schema, {
			account: with_properties(account, { username: USERNAME_NODE })
		})
	};
};

const BODY_400: ErrorMove = {
	from: ['invalid_json_body', 'invalid_request_body'],
	to: [REST_INVALID_REQUEST_BODY, REST_INVALID_JSON_BODY]
};
const AUTH_401: ErrorMove = { from: ['*'], to: [REST_AUTHENTICATION_REQUIRED] };
const RATE_429: ErrorMove = { from: ['rate_limit_exceeded'], to: [REST_RATE_LIMIT_EXCEEDED] };

// the declared moves of the error rules, by `METHOD path` and status
const ERROR_MOVES: Record<string, Record<number, ErrorMove>> = {
	'GET /verify': { 401: AUTH_401 },
	'POST /login': { 400: BODY_400, 429: RATE_429 },
	'POST /logout': { 401: AUTH_401 },
	'POST /password': {
		400: BODY_400,
		401: { from: ['*'], to: [REST_AUTHENTICATION_REQUIRED, REST_INVALID_CREDENTIALS] },
		429: RATE_429
	},
	'POST /signup': { 400: BODY_400, 429: RATE_429 },
	'POST /bootstrap': { 400: BODY_400, 429: RATE_429 }
};

/** A captured route with every declared move applied: its own, then the error rules'. */
const moved = (r: Record<string, any>): Record<string, any> => {
	const key = `${r.method} ${r.path}`;
	return with_error_moves(MOVES[key]?.(r) ?? r, ERROR_MOVES[key]);
};

const TRANSFORM_MESSAGE =
	'Part of the schema has no JSON Schema form and is left out or written as {} there: Transforms cannot be represented in JSON Schema';

const SIGNUP_EMAIL_CHECK: AppSurfaceDiagnostic = {
	level: 'info',
	category: 'schema',
	message:
		'Part of the schema has no JSON Schema form and is left out or written as {} there: cannot express `check` at #/properties/email/anyOf/0: it holds a function',
	source: 'POST /signup input'
};

describe('account routes surface', () => {
	const head: SurfaceCapture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
	const surface = capture_surface();

	test('the capture is of every account route', () => {
		assert.deepStrictEqual(
			head.routes.map((r) => `${r.method} ${r.path}`),
			[
				'GET /verify',
				'POST /login',
				'POST /logout',
				'POST /password',
				'GET /status',
				'POST /signup',
				'POST /bootstrap'
			]
		);
	});

	test('the routes are the captured ones but for the declared moves', () => {
		assert.deepStrictEqual(surface.routes, head.routes.map(moved));
	});

	test("every error schema is the capture's but for the error rules' moves", () => {
		assert.deepStrictEqual(
			surface.routes.map((r) => r.error_schemas),
			head.routes.map(
				(r) => with_error_moves(r, ERROR_MOVES[`${r.method} ${r.path}`]).error_schemas
			)
		);
	});

	test("the diagnostics are the capture's, the transforms' gone and the signup Email check's added", () => {
		const kept = head.diagnostics.filter((d) => d.message !== TRANSFORM_MESSAGE);
		assert.strictEqual(head.diagnostics.length - kept.length, 2);
		assert.deepStrictEqual(surface.diagnostics, [...kept, SIGNUP_EMAIL_CHECK]);
	});
});
