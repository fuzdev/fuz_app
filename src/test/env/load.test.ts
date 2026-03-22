/**
 * Tests for env/load.ts — generic env loading from Zod schemas.
 *
 * @module
 */

import {describe, test, assert, vi} from 'vitest';
import {z} from 'zod';

import {load_env, EnvValidationError, log_env_validation_error} from '$lib/env/load.js';
import {BaseServerEnv} from '$lib/server/env.js';

/** Minimal valid env for BaseServerEnv (only required fields, no defaults). */
const VALID_ENV: Record<string, string> = {
	NODE_ENV: 'development',
	SECRET_COOKIE_KEYS: 'a'.repeat(32),
	ALLOWED_ORIGINS: 'http://localhost:*',
	DATABASE_URL: 'memory://',
};

/** Trigger an EnvValidationError from load_env and return it. */
const catch_env_error = (get_env: (key: string) => string | undefined): EnvValidationError => {
	try {
		load_env(BaseServerEnv, get_env);
		assert.fail('should have thrown');
	} catch (e) {
		assert.instanceOf(e, EnvValidationError);
		return e;
	}
};

describe('load_env', () => {
	test('loads env from getter function', () => {
		const env_map = new Map(Object.entries(VALID_ENV));
		const result = load_env(BaseServerEnv, (key) => env_map.get(key));
		assert.strictEqual(result.NODE_ENV, 'development');
		assert.strictEqual(result.PORT, 4040);
	});

	test('throws EnvValidationError on invalid env', () => {
		catch_env_error(() => undefined);
	});

	test('works with custom schemas', () => {
		const schema = z.strictObject({
			FOO: z.string(),
			BAR: z.coerce.number(),
		});
		const env: Record<string, string> = {FOO: 'hello', BAR: '42'};
		const result = load_env(schema, (key) => env[key]);
		assert.strictEqual(result.FOO, 'hello');
		assert.strictEqual(result.BAR, 42);
	});
});

describe('EnvValidationError', () => {
	test('has all_undefined true when no vars set', () => {
		const err = catch_env_error(() => undefined);
		assert.isTrue(err.all_undefined);
	});

	test('has all_undefined false when some vars set', () => {
		const partial_env = new Map([['PORT', '4040']]);
		const err = catch_env_error((key) => partial_env.get(key));
		assert.isFalse(err.all_undefined);
	});

	test('format_issues() returns formatted strings', () => {
		const err = catch_env_error(() => undefined);
		const issues = err.format_issues();
		assert.isArray(issues);
		assert.isAbove(issues.length, 0);
		for (const issue of issues) {
			assert.include(issue, ':');
		}
	});

	test('format_issues() includes field names', () => {
		const partial_env = new Map([['PORT', '4040']]);
		const err = catch_env_error((key) => partial_env.get(key));
		const issues = err.format_issues();
		const has_node_env = issues.some((i: string) => i.startsWith('NODE_ENV:'));
		assert.isTrue(has_node_env);
	});

	test('raw contains the values that were read', () => {
		const partial_env = new Map([['PORT', '4040']]);
		const err = catch_env_error((key) => partial_env.get(key));
		assert.strictEqual(err.raw.PORT, '4040');
		assert.strictEqual(err.raw.NODE_ENV, undefined);
	});
});

describe('log_env_validation_error', () => {
	test('logs "No environment configured" when all_undefined', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const err = catch_env_error(() => undefined);
			log_env_validation_error(err);
			assert.strictEqual(spy.mock.calls.length, 1);
			assert.ok((spy.mock.calls[0]![0] as string).includes('No environment configured'));
		} finally {
			spy.mockRestore();
		}
	});

	test('logs individual issues when partially configured', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const partial_env = new Map([['PORT', '4040']]);
			const err = catch_env_error((key) => partial_env.get(key));
			log_env_validation_error(err);
			// 1 header line + 1 line per issue
			const expected_calls = 1 + err.format_issues().length;
			assert.strictEqual(spy.mock.calls.length, expected_calls);
			assert.ok((spy.mock.calls[0]![0] as string).includes('Invalid environment configuration'));
			// Issue lines are indented with two spaces
			for (let i = 1; i < spy.mock.calls.length; i++) {
				assert.ok((spy.mock.calls[i]![0] as string).includes('  '));
			}
		} finally {
			spy.mockRestore();
		}
	});

	test('prepends label when provided', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const err = catch_env_error(() => undefined);
			log_env_validation_error(err, 'my-app');
			assert.ok((spy.mock.calls[0]![0] as string).startsWith('[my-app] '));
		} finally {
			spy.mockRestore();
		}
	});
});
