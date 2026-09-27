/**
 * Tests for schema_helpers - shared pure helpers for schema introspection.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { z } from 'zod';

import {
	is_null_schema,
	is_strict_object_schema,
	is_void_schema,
	to_void_params,
	to_input_params,
	safe_parse_dropping_unknown_keys,
	schema_to_surface,
	middleware_applies,
	merge_error_schemas
} from '$lib/http/schema_helpers.ts';

describe('is_null_schema', () => {
	test('returns true for z.null()', () => {
		assert.strictEqual(is_null_schema(z.null()), true);
	});

	test('returns false for z.string()', () => {
		assert.strictEqual(is_null_schema(z.string()), false);
	});

	test('returns false for z.strictObject()', () => {
		assert.strictEqual(is_null_schema(z.strictObject({ name: z.string() })), false);
	});

	test('returns false for z.nullable(z.string()) — accepts null but is not z.null()', () => {
		assert.strictEqual(is_null_schema(z.nullable(z.string())), false);
	});

	test('returns false for z.void()', () => {
		assert.strictEqual(is_null_schema(z.void()), false);
	});
});

describe('is_void_schema', () => {
	test('returns true for z.void()', () => {
		assert.strictEqual(is_void_schema(z.void()), true);
	});

	test('returns false for z.null()', () => {
		assert.strictEqual(is_void_schema(z.null()), false);
	});

	test('returns false for z.undefined()', () => {
		assert.strictEqual(is_void_schema(z.undefined()), false);
	});

	test('returns false for z.string()', () => {
		assert.strictEqual(is_void_schema(z.string()), false);
	});

	test('returns false for z.strictObject()', () => {
		assert.strictEqual(is_void_schema(z.strictObject({ name: z.string() })), false);
	});
});

describe('to_void_params', () => {
	test('reads absent, null, and {} as the no-arg call', () => {
		for (const params of [undefined, null, {}]) {
			assert.strictEqual(to_void_params(params), undefined, JSON.stringify(params));
		}
	});

	test('passes any other shape through for z.void() to refuse', () => {
		for (const params of [{ a: 1 }, [], [1], 0, '', false]) {
			assert.strictEqual(to_void_params(params), params, JSON.stringify(params));
		}
	});
});

describe('to_input_params', () => {
	test('applies to_void_params to a z.void() input', () => {
		for (const params of [undefined, null, {}]) {
			assert.strictEqual(to_input_params(z.void(), params), undefined, JSON.stringify(params));
		}
		const extra = { a: 1 };
		assert.strictEqual(to_input_params(z.void(), extra), extra);
	});

	test('reads absent and null params of any other input as {}', () => {
		const input = z.strictObject({ limit: z.number().optional() });
		assert.deepStrictEqual(to_input_params(input, undefined), {});
		assert.deepStrictEqual(to_input_params(input, null), {});
		const params = { limit: 2 };
		assert.strictEqual(to_input_params(input, params), params);
	});
});

describe('safe_parse_dropping_unknown_keys', () => {
	const schema = z.strictObject({
		a: z.number(),
		nested: z.strictObject({ b: z.string() }).optional(),
		list: z.array(z.strictObject({ c: z.boolean() })).optional()
	});

	test('passes a matching value through', () => {
		const result = safe_parse_dropping_unknown_keys(schema, { a: 1 });
		assert.ok(result.success);
		assert.deepStrictEqual(result.data, { a: 1 });
	});

	test('drops undeclared keys at every depth without mutating the input', () => {
		const value = { a: 1, x: 0, nested: { b: 'b', y: 0 }, list: [{ c: true, z: 0 }] };
		const snapshot = structuredClone(value);
		const result = safe_parse_dropping_unknown_keys(schema, value);
		assert.ok(result.success);
		assert.deepStrictEqual(result.data, { a: 1, nested: { b: 'b' }, list: [{ c: true }] });
		assert.deepStrictEqual(value, snapshot);
	});

	test('still fails on any other issue, with the original issues', () => {
		const result = safe_parse_dropping_unknown_keys(schema, { a: 'nope', x: 0 });
		assert.ok(!result.success);
		const codes = result.error.issues.map((issue) => issue.code).sort();
		assert.deepStrictEqual(codes, ['invalid_type', 'unrecognized_keys']);
	});
});

describe('is_strict_object_schema', () => {
	test('returns true for z.strictObject()', () => {
		assert.strictEqual(is_strict_object_schema(z.strictObject({ name: z.string() })), true);
	});

	test('returns false for z.object()', () => {
		assert.strictEqual(is_strict_object_schema(z.object({ name: z.string() })), false);
	});

	test('returns false for z.looseObject()', () => {
		assert.strictEqual(is_strict_object_schema(z.looseObject({ name: z.string() })), false);
	});

	test('returns false for z.string()', () => {
		assert.strictEqual(is_strict_object_schema(z.string()), false);
	});

	test('returns false for z.null()', () => {
		assert.strictEqual(is_strict_object_schema(z.null()), false);
	});
});

describe('schema_to_surface', () => {
	test('returns null for null schema', () => {
		assert.strictEqual(schema_to_surface(z.null()), null);
	});

	test('returns JSON Schema for object schema', () => {
		const schema = z.strictObject({ name: z.string() });
		const result = schema_to_surface(schema) as Record<string, unknown>;
		assert.ok(result);
		assert.strictEqual(result.type, 'object');
		assert.ok(result.properties);
	});

	test('strips $schema from output', () => {
		const schema = z.strictObject({ id: z.number() });
		const result = schema_to_surface(schema) as Record<string, unknown>;
		assert.ok(result);
		assert.strictEqual('$schema' in result, false);
	});

	test('returns JSON Schema for string schema', () => {
		const result = schema_to_surface(z.string()) as Record<string, unknown>;
		assert.ok(result);
		assert.strictEqual(result.type, 'string');
	});

	test('strips default from output to avoid non-deterministic function defaults', () => {
		const schema = z.strictObject({
			created: z.string().default(() => new Date().toISOString()),
			name: z.string()
		});
		const result = schema_to_surface(schema) as Record<string, unknown>;
		assert.ok(result);
		const props = result.properties as Record<string, Record<string, unknown>>;
		assert.ok(props.created);
		assert.ok(props.name);
		assert.strictEqual('default' in props.created, false);
		// structural fields preserved
		assert.strictEqual(props.created.type, 'string');
		assert.strictEqual(props.name.type, 'string');
	});

	test('strips default from nested schemas', () => {
		const schema = z.strictObject({
			outer: z.strictObject({
				inner: z.number().default(42)
			})
		});
		const result = schema_to_surface(schema) as Record<string, unknown>;
		assert.ok(result);
		const outer = (result.properties as Record<string, Record<string, unknown>>).outer;
		assert.ok(outer);
		const inner_props = outer.properties as Record<string, Record<string, unknown>>;
		assert.ok(inner_props);
		const inner = inner_props.inner;
		assert.ok(inner);
		assert.strictEqual('default' in inner, false);
		assert.strictEqual(inner.type, 'number');
	});

	test('surface is deterministic with function defaults', () => {
		const schema = z.strictObject({
			ts: z.string().default(() => new Date().toISOString())
		});
		const a = schema_to_surface(schema);
		const b = schema_to_surface(schema);
		assert.deepStrictEqual(a, b);
	});

	test('returns null for schema that cannot convert to JSON Schema', () => {
		// custom schema that rejects null (so is_null_schema returns false)
		// but throws on toJSONSchema — exercises the catch path
		const unconvertible = z.custom<unknown>((v) => v !== null && v !== undefined);
		const result = schema_to_surface(unconvertible);
		assert.strictEqual(result, null);
	});
});

describe('middleware_applies', () => {
	test('exact match', () => {
		assert.strictEqual(middleware_applies('/health', '/health'), true);
	});

	test('wildcard matches subpath', () => {
		assert.strictEqual(middleware_applies('/api/*', '/api/account/login'), true);
	});

	test('wildcard matches exact prefix without trailing slash', () => {
		assert.strictEqual(middleware_applies('/api/*', '/api'), true);
	});

	test('wildcard does not match different prefix', () => {
		assert.strictEqual(middleware_applies('/api/zap/*', '/api/account/login'), false);
	});

	test('scoped wildcard matches within scope', () => {
		assert.strictEqual(middleware_applies('/api/zap/*', '/api/zap/runs'), true);
	});

	test('no match for unrelated paths', () => {
		assert.strictEqual(middleware_applies('/foo', '/bar'), false);
	});

	test('root wildcard matches any path', () => {
		assert.strictEqual(middleware_applies('/*', '/anything'), true);
		assert.strictEqual(middleware_applies('/*', '/deep/nested/path'), true);
	});

	test('bare star matches everything', () => {
		assert.strictEqual(middleware_applies('*', '/anything'), true);
		assert.strictEqual(middleware_applies('*', '/api/deep/path'), true);
		assert.strictEqual(middleware_applies('*', '/'), true);
	});

	test('wildcard does not match partial prefix', () => {
		assert.strictEqual(middleware_applies('/api/*', '/api2/foo'), false);
	});

	test('exact match does not match subpath', () => {
		assert.strictEqual(middleware_applies('/api', '/api/foo'), false);
	});
});

describe('merge_error_schemas', () => {
	test('returns null for no-auth no-input route', () => {
		const result = merge_error_schemas({
			auth: { account: 'none', actor: 'none' },
			input: z.null()
		});
		assert.strictEqual(result, null);
	});

	test('derives 401 for authenticated route', () => {
		const result = merge_error_schemas({
			auth: { account: 'required', actor: 'none' },
			input: z.null()
		});
		assert.ok(result);
		assert.ok(result[401]);
		assert.strictEqual(result[400], undefined);
	});

	test('derives 400 for route with input', () => {
		const result = merge_error_schemas({
			auth: { account: 'none', actor: 'none' },
			input: z.strictObject({ name: z.string() })
		});
		assert.ok(result);
		assert.ok(result[400]);
	});

	test('derives 400 for route with params', () => {
		const result = merge_error_schemas({
			auth: { account: 'none', actor: 'none' },
			input: z.null(),
			params: z.strictObject({ id: z.string() })
		});
		assert.ok(result);
		assert.ok(result[400]);
	});

	test('derives 401 + 403 for role route', () => {
		const result = merge_error_schemas({
			auth: { account: 'required', actor: 'required', roles: ['admin'] },
			input: z.null()
		});
		assert.ok(result);
		assert.ok(result[401]);
		assert.ok(result[403]);
	});

	test('derives 401 + 403 for keeper route', () => {
		const result = merge_error_schemas({
			auth: {
				account: 'required',
				actor: 'required',
				roles: ['keeper'],
				credential_types: ['daemon_token']
			},
			input: z.null()
		});
		assert.ok(result);
		assert.ok(result[401]);
		assert.ok(result[403]);
	});

	test('derives 429 for ip rate-limited route', () => {
		const result = merge_error_schemas({
			auth: { account: 'none', actor: 'none' },
			input: z.null(),
			rate_limit: 'ip'
		});
		assert.ok(result);
		assert.ok(result[429]);
	});

	test('derives 429 for account rate-limited route', () => {
		const result = merge_error_schemas({
			auth: { account: 'none', actor: 'none' },
			input: z.null(),
			rate_limit: 'account'
		});
		assert.ok(result);
		assert.ok(result[429]);
	});

	test('derives 429 for both rate-limited route', () => {
		const result = merge_error_schemas({
			auth: { account: 'none', actor: 'none' },
			input: z.null(),
			rate_limit: 'both'
		});
		assert.ok(result);
		assert.ok(result[429]);
	});

	test('explicit errors override derived', () => {
		const Custom404 = z.looseObject({ error: z.literal('not_found') });
		const result = merge_error_schemas({
			auth: { account: 'required', actor: 'none' },
			input: z.null(),
			errors: { 404: Custom404 }
		});
		assert.ok(result);
		assert.strictEqual(result[404], Custom404);
		assert.ok(result[401]); // derived still present
	});

	test('middleware errors merge with derived', () => {
		const MwError = z.looseObject({ error: z.string() });
		const result = merge_error_schemas(
			{
				auth: { account: 'none', actor: 'none' },
				input: z.null()
			},
			{ 503: MwError }
		);
		assert.ok(result);
		assert.strictEqual(result[503], MwError);
	});

	test('explicit overrides middleware for same status', () => {
		const MwError = z.looseObject({ error: z.literal('mw') });
		const RouteError = z.looseObject({ error: z.literal('route') });
		const result = merge_error_schemas(
			{
				auth: { account: 'none', actor: 'none' },
				input: z.null(),
				errors: { 500: RouteError }
			},
			{ 500: MwError }
		);
		assert.ok(result);
		assert.strictEqual(result[500], RouteError);
	});
});
