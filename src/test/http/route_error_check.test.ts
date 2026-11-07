/**
 * Tests for `http/route_error_check.ts`: the rule the DEV error check and the
 * test helpers share (`check_route_error`, `format_route_error_check`), and
 * the hono-free route lookup (`compile_route_path`, `find_mounted_route`).
 * The lookup is held to Hono's own matching in `dev_route_error_check.test.ts`.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { literal } from '@fuzdev/fuz_schema/schema.ts';

import { rest_error } from '#lib/http/error_schemas.ts';
import { resolve_route_error_map } from '#lib/http/route_errors.ts';
import {
	check_route_error,
	compile_route_path,
	find_mounted_route,
	format_route_error_check,
	to_mounted_routes
} from '#lib/http/route_error_check.ts';

const errors = resolve_route_error_map({
	method: 'GET',
	path: '/v',
	auth: { account: 'none', actor: 'none' },
	input: literal(null),
	errors: [rest_error(409, 'slug_taken'), rest_error(409, 'slug_reserved')]
});

describe('check_route_error', () => {
	test('answers each kind', () => {
		assert.deepStrictEqual(check_route_error(errors, 409, { error: 'slug_taken' }, false), {
			ok: true
		});
		assert.deepStrictEqual(check_route_error(errors, 418, { error: 'x' }, false), {
			ok: false,
			kind: 'undeclared_status'
		});
		const mismatch = check_route_error(errors, 409, { error: 'x' }, false);
		assert.ok(!mismatch.ok && mismatch.kind === 'schema_mismatch' && mismatch.issues.length > 0);
	});

	test('a status of several definitions takes each code and no other', () => {
		assert.ok(check_route_error(errors, 409, { error: 'slug_reserved' }, false).ok);
		assert.ok(!check_route_error(errors, 409, { error: 'internal_error' }, false).ok);
	});

	test('a JSON-RPC error envelope passes only on a jsonrpc route', () => {
		const envelope = { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'x' } };
		assert.ok(check_route_error(errors, 409, envelope, true).ok);
		assert.ok(!check_route_error(errors, 409, envelope, false).ok);
	});

	test('the exemptions take the body, not just the status', () => {
		assert.ok(check_route_error(errors, 500, { error: 'internal_error', message: 'm' }, false).ok);
		assert.ok(check_route_error(errors, 503, { error: 'service_unavailable' }, false).ok);
		assert.ok(!check_route_error(errors, 500, { error: 'boom' }, false).ok);
		assert.ok(!check_route_error(errors, 503, { error: 'down' }, false).ok);
	});
});

describe('format_route_error_check', () => {
	test('names the kind, the status, and the request', () => {
		assert.strictEqual(
			format_route_error_check({ ok: false, kind: 'undeclared_status' }, 418, 'GET /v'),
			'Undeclared error status (418): GET /v'
		);
		assert.strictEqual(
			format_route_error_check({ ok: false, kind: 'schema_mismatch', issues: [] }, 409, 'GET /v'),
			'Error schema mismatch (409): GET /v'
		);
	});
});

describe('the hono-free route lookup', () => {
	test('a `*` inside a segment is refused, not guessed at', () => {
		assert.throws(() => compile_route_path('/a*'), /has a `\*` inside a segment/);
		assert.throws(() => compile_route_path('/x/b*c/d'), /"b\*c"/);
		// a whole `*` segment, and a `*` inside a param's pattern, are read
		compile_route_path('/x/*');
		compile_route_path('/f/:name{.*}');
	});

	test('find_mounted_route takes the first in order and reads HEAD as GET', () => {
		const routes = to_mounted_routes(
			[
				{ method: 'GET', path: '/a/:id', name: 'param' },
				{ method: 'GET', path: '/a/new', name: 'literal' },
				{ method: 'POST', path: '/a/new', name: 'post' }
			],
			(r) => r.name
		);
		assert.strictEqual(find_mounted_route(routes, 'GET', '/a/new'), 'param');
		assert.strictEqual(find_mounted_route(routes, 'HEAD', '/a/new'), 'param');
		assert.strictEqual(find_mounted_route(routes, 'POST', '/a/new'), 'post');
		assert.strictEqual(find_mounted_route(routes, 'DELETE', '/a/new'), undefined);
		assert.strictEqual(find_mounted_route(routes, 'GET', '/b'), undefined);
	});
});
