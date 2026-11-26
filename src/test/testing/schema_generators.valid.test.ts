/**
 * Tests for `resolve_valid_path` and `generate_valid_body`.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import {
	brand,
	check,
	iso_datetime,
	literal,
	min_length,
	number,
	object,
	one_of,
	optional,
	parse,
	parse_or_throw,
	pipe,
	string,
	with_default
} from '@fuzdev/fuz_schema/schema.ts';
import { resolve_valid_path, generate_valid_body } from '#lib/testing/schema_generators.ts';
import { Email, Uuid } from '#lib/primitive_schemas.ts';

// --- resolve_valid_path and generate_valid_body tests ---

describe('resolve_valid_path', () => {
	test('replaces uuid params with nil UUID', () => {
		const params = object({ id: Uuid });
		assert.strictEqual(
			resolve_valid_path('/things/:id', params),
			'/things/00000000-0000-0000-0000-000000000000'
		);
	});

	test('synthesizes a schema-satisfying value for a non-uuid param', () => {
		const params = object({ name: string });
		const resolved = resolve_valid_path('/things/:name', params);
		assert.ok(parse(params, { name: resolved.slice('/things/'.length) }).ok);
	});

	test('falls back to the test_ prefix for a param the schema does not name', () => {
		const params = object({ other: string });
		assert.strictEqual(resolve_valid_path('/things/:name', params), '/things/test_name');
	});

	test('handles multiple params', () => {
		const params = object({
			account_id: Uuid,
			role_grant_id: Uuid
		});
		assert.strictEqual(
			resolve_valid_path('/accounts/:account_id/role_grants/:role_grant_id', params),
			'/accounts/00000000-0000-0000-0000-000000000000/role_grants/00000000-0000-0000-0000-000000000000'
		);
	});

	test('falls back to test_ prefix without params schema', () => {
		assert.strictEqual(resolve_valid_path('/things/:id'), '/things/test_id');
	});
});

describe('generate_valid_body', () => {
	test('returns undefined for null schema', () => {
		assert.strictEqual(generate_valid_body(literal(null)), undefined);
	});

	test('generates valid body for simple object schema', () => {
		const schema = object({ name: pipe(string, min_length(1)) });
		const body = generate_valid_body(schema);
		assert.ok(body);
		assert.ok(typeof body.name === 'string');
		assert.ok(body.name.length >= 1);
		// confirm it actually passes validation
		parse_or_throw(schema, body);
	});

	test('generates valid body with uuid field', () => {
		const schema = object({ id: Uuid });
		const body = generate_valid_body(schema);
		assert.ok(body);
		assert.strictEqual(body.id, '00000000-0000-0000-0000-000000000000');
		parse_or_throw(schema, body);
	});

	test('skips optional fields without defaults', () => {
		const schema = object({
			required_field: string,
			optional_field: optional(string)
		});
		const body = generate_valid_body(schema);
		assert.ok(body);
		assert.ok('required_field' in body);
		assert.ok(!('optional_field' in body));
		parse_or_throw(schema, body);
	});

	test('generates valid body with absolute path refinement', () => {
		const AbsPath = pipe(
			string,
			check((p) => p.startsWith('/'))
		);
		const schema = object({ path: AbsPath });
		const body = generate_valid_body(schema);
		assert.ok(body);
		const path = body.path;
		assert.ok(typeof path === 'string');
		assert.ok(path.startsWith('/'));
		parse_or_throw(schema, body);
	});

	test('generates valid body with date-time field', () => {
		const schema = object({ created: pipe(string, iso_datetime) });
		const body = generate_valid_body(schema);
		assert.ok(body);
		assert.strictEqual(body.created, '2020-01-01T00:00:00.000Z');
		parse_or_throw(schema, body);
	});

	test('generates valid body with nested object', () => {
		const schema = object({
			config: object({
				name: string,
				count: number
			})
		});
		const body = generate_valid_body(schema);
		assert.ok(body);
		const config = body.config as Record<string, unknown>;
		assert.ok(typeof config.name === 'string');
		assert.ok(typeof config.count === 'number');
		parse_or_throw(schema, body);
	});

	test('generates valid body with nested object containing optional fields', () => {
		const schema = object({
			settings: object({
				required_field: string,
				optional_field: optional(number)
			})
		});
		const body = generate_valid_body(schema);
		assert.ok(body);
		const settings = body.settings as Record<string, unknown>;
		assert.ok('required_field' in settings);
		assert.ok(!('optional_field' in settings));
		parse_or_throw(schema, body);
	});

	test('generates valid body with email field', () => {
		const schema = object({ email: Email });
		const body = generate_valid_body(schema);
		assert.ok(body);
		assert.strictEqual(body.email, 'test@example.com');
		parse_or_throw(schema, body);
	});

	test('generates valid body with url refinement', () => {
		const schema = object({
			link: pipe(
				string,
				check((v) => URL.canParse(v) && v.startsWith('https://'))
			)
		});
		const body = generate_valid_body(schema);
		assert.ok(body);
		const link = body.link;
		assert.ok(typeof link === 'string');
		assert.ok(link.startsWith('https://'));
		parse_or_throw(schema, body);
	});

	test('generates valid body with branded string', () => {
		const Branded = brand(
			pipe(
				string,
				check((p) => p.startsWith('/'))
			),
			'AbsPath'
		);
		const schema = object({ path: Branded });
		const body = generate_valid_body(schema);
		assert.ok(body);
		const path = body.path;
		assert.ok(typeof path === 'string');
		assert.ok(path.startsWith('/'));
		parse_or_throw(schema, body);
	});

	test('generates valid body with enum field', () => {
		const schema = object({
			status: one_of(['active', 'inactive', 'pending'])
		});
		const body = generate_valid_body(schema);
		assert.ok(body);
		assert.strictEqual(body.status, 'active');
		parse_or_throw(schema, body);
	});

	test('includes fields with defaults', () => {
		const schema = object({
			name: string,
			color: with_default(string, 'blue')
		});
		const body = generate_valid_body(schema);
		assert.ok(body);
		assert.ok('name' in body);
		assert.ok('color' in body);
		parse_or_throw(schema, body);
	});

	test('throws for unsatisfiable schema', () => {
		// Refinement that always rejects — generation produces a value that fails validation
		const schema = object({
			impossible: pipe(
				string,
				check(() => false)
			)
		});
		assert.throws(() => generate_valid_body(schema), /generate_valid_body/);
	});

	test('generates valid body for hex-pattern string (blake3 hash)', async () => {
		// `account_session_revoke_action_spec.input` has `session_id: SessionId`
		// (`^[0-9a-f]{64}$`). The generator must produce a value that round-trips
		// through the input schema without error — previously it returned the
		// default `'xxxxxxxxxx'` which fails the regex.
		const { account_session_revoke_action_spec } =
			await import('#lib/auth/account_action_specs.ts');
		const body = generate_valid_body(account_session_revoke_action_spec.input);
		assert.ok(body);
		const parsed = parse(account_session_revoke_action_spec.input, body);
		assert.ok(parsed.ok, `generated body should pass schema: ${JSON.stringify(parsed)}`);
	});
});
