/**
 * Tests for schema_helpers - shared pure helpers for schema introspection.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';
import {z} from 'zod';

import {
	is_null_schema,
	schema_to_surface,
	middleware_applies,
	merge_error_schemas,
} from '$lib/http/schema_helpers.js';

describe('is_null_schema', () => {
	test('returns true for z.null()', () => {
		assert.strictEqual(is_null_schema(z.null()), true);
	});

	test('returns false for z.string()', () => {
		assert.strictEqual(is_null_schema(z.string()), false);
	});

	test('returns false for z.strictObject()', () => {
		assert.strictEqual(is_null_schema(z.strictObject({name: z.string()})), false);
	});

	test('returns false for z.nullable(z.string()) — accepts null but is not z.null()', () => {
		assert.strictEqual(is_null_schema(z.nullable(z.string())), false);
	});

	test('returns false for z.void()', () => {
		assert.strictEqual(is_null_schema(z.void()), false);
	});
});

describe('schema_to_surface', () => {
	test('returns null for null schema', () => {
		assert.strictEqual(schema_to_surface(z.null()), null);
	});

	test('returns JSON Schema for object schema', () => {
		const schema = z.strictObject({name: z.string()});
		const result = schema_to_surface(schema) as Record<string, unknown>;
		assert.ok(result);
		assert.strictEqual(result.type, 'object');
		assert.ok(result.properties);
	});

	test('strips $schema from output', () => {
		const schema = z.strictObject({id: z.number()});
		const result = schema_to_surface(schema) as Record<string, unknown>;
		assert.ok(result);
		assert.strictEqual('$schema' in result, false);
	});

	test('returns JSON Schema for string schema', () => {
		const result = schema_to_surface(z.string()) as Record<string, unknown>;
		assert.ok(result);
		assert.strictEqual(result.type, 'string');
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
		assert.strictEqual(middleware_applies('/api/tx/*', '/api/account/login'), false);
	});

	test('scoped wildcard matches within scope', () => {
		assert.strictEqual(middleware_applies('/api/tx/*', '/api/tx/runs'), true);
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
			auth: {type: 'none'},
			input: z.null(),
		});
		assert.strictEqual(result, null);
	});

	test('derives 401 for authenticated route', () => {
		const result = merge_error_schemas({
			auth: {type: 'authenticated'},
			input: z.null(),
		});
		assert.ok(result);
		assert.ok(result[401]);
		assert.strictEqual(result[400], undefined);
	});

	test('derives 400 for route with input', () => {
		const result = merge_error_schemas({
			auth: {type: 'none'},
			input: z.strictObject({name: z.string()}),
		});
		assert.ok(result);
		assert.ok(result[400]);
	});

	test('derives 400 for route with params', () => {
		const result = merge_error_schemas({
			auth: {type: 'none'},
			input: z.null(),
			params: z.strictObject({id: z.string()}),
		});
		assert.ok(result);
		assert.ok(result[400]);
	});

	test('derives 401 + 403 for role route', () => {
		const result = merge_error_schemas({
			auth: {type: 'role', role: 'admin'},
			input: z.null(),
		});
		assert.ok(result);
		assert.ok(result[401]);
		assert.ok(result[403]);
	});

	test('derives 401 + 403 for keeper route', () => {
		const result = merge_error_schemas({
			auth: {type: 'keeper'},
			input: z.null(),
		});
		assert.ok(result);
		assert.ok(result[401]);
		assert.ok(result[403]);
	});

	test('derives 429 for ip rate-limited route', () => {
		const result = merge_error_schemas({
			auth: {type: 'none'},
			input: z.null(),
			rate_limit: 'ip',
		});
		assert.ok(result);
		assert.ok(result[429]);
	});

	test('derives 429 for account rate-limited route', () => {
		const result = merge_error_schemas({
			auth: {type: 'none'},
			input: z.null(),
			rate_limit: 'account',
		});
		assert.ok(result);
		assert.ok(result[429]);
	});

	test('derives 429 for both rate-limited route', () => {
		const result = merge_error_schemas({
			auth: {type: 'none'},
			input: z.null(),
			rate_limit: 'both',
		});
		assert.ok(result);
		assert.ok(result[429]);
	});

	test('explicit errors override derived', () => {
		const Custom404 = z.looseObject({error: z.literal('not_found')});
		const result = merge_error_schemas({
			auth: {type: 'authenticated'},
			input: z.null(),
			errors: {404: Custom404},
		});
		assert.ok(result);
		assert.strictEqual(result[404], Custom404);
		assert.ok(result[401]); // derived still present
	});

	test('middleware errors merge with derived', () => {
		const MwError = z.looseObject({error: z.string()});
		const result = merge_error_schemas(
			{
				auth: {type: 'none'},
				input: z.null(),
			},
			{503: MwError},
		);
		assert.ok(result);
		assert.strictEqual(result[503], MwError);
	});

	test('explicit overrides middleware for same status', () => {
		const MwError = z.looseObject({error: z.literal('mw')});
		const RouteError = z.looseObject({error: z.literal('route')});
		const result = merge_error_schemas(
			{
				auth: {type: 'none'},
				input: z.null(),
				errors: {500: RouteError},
			},
			{500: MwError},
		);
		assert.ok(result);
		assert.strictEqual(result[500], RouteError);
	});
});
