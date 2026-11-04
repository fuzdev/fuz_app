/**
 * Tests for env/load.ts — generic env loading from fuz_schema object schemas.
 *
 * @module
 */

import { describe, test, assert, vi } from 'vitest';
import {
	check,
	object,
	optional,
	pipe,
	record,
	string,
	transform,
	with_default
} from '@fuzdev/fuz_schema/schema.ts';

import { load_env, EnvValidationError, log_env_validation_error } from '#lib/env/load.ts';
import { BaseServerEnv } from '#lib/server/env.ts';
import { env_integer } from '#lib/env/env_schemas.ts';

/** Minimal valid env for BaseServerEnv (only required fields, no defaults). */
const VALID_ENV: Record<string, string> = {
	NODE_ENV: 'development',
	SECRET_FUZ_COOKIE_KEYS: 'a'.repeat(32),
	FUZ_ALLOWED_ORIGINS: 'http://localhost:*',
	DATABASE_URL: 'memory://'
};

/** Trigger an EnvValidationError from load_env and return it. */
const catch_env_error = (get_env: (key: string) => string | undefined): EnvValidationError => {
	try {
		load_env(BaseServerEnv, get_env);
	} catch (e) {
		assert.instanceOf(e, EnvValidationError);
		return e;
	}
	assert.fail('should have thrown');
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
		const schema = object({
			FOO: string,
			BAR: env_integer()
		});
		const env: Record<string, string> = { FOO: 'hello', BAR: '42' };
		const result = load_env(schema, (key) => env[key]);
		assert.strictEqual(result.FOO, 'hello');
		assert.strictEqual(result.BAR, 42);
	});

	test('reads only the schema keys', () => {
		const read: Array<string> = [];
		load_env(object({ A: optional(string), B: optional(string) }), (key) => {
			read.push(key);
			return undefined;
		});
		assert.deepStrictEqual(read, ['A', 'B']);
	});

	test('an unset var is a missing key: a pipe starting with optional runs no step', () => {
		let steps = 0;
		const schema = object({
			MAYBE: pipe(
				optional(string),
				check((v: string | undefined) => {
					steps++;
					return v !== undefined;
				}),
				transform((v: string | undefined) => v!.toUpperCase())
			),
			WITH_DEFAULT: with_default(string, 'fallback')
		});
		const result = load_env(schema, () => undefined);
		assert.strictEqual(steps, 0);
		assert.isFalse('MAYBE' in result);
		assert.strictEqual(result.WITH_DEFAULT, 'fallback');
		// set, the steps run
		const set = load_env(schema, (key) => (key === 'MAYBE' ? 'x' : undefined));
		assert.strictEqual(steps, 1);
		assert.strictEqual(set.MAYBE, 'X');
	});

	test('an unset var stays in raw as undefined', () => {
		const schema = object({ SET: string, UNSET: string });
		try {
			load_env(schema, (key) => (key === 'SET' ? 'v' : undefined));
			assert.fail('should have thrown');
		} catch (e) {
			assert.instanceOf(e, EnvValidationError);
			assert.deepStrictEqual(e.raw, { SET: 'v', UNSET: undefined });
			assert.isTrue('UNSET' in e.raw);
			assert.deepStrictEqual(
				e.issues.map((i) => i.path),
				[['UNSET']]
			);
		}
	});

	test('throws a TypeError for a schema that is not an object schema', () => {
		// refused by type too, a schema that outputs no object
		// @ts-expect-error
		assert.throws(() => load_env(string, () => undefined), TypeError);
		// an object output that is not an object schema passes the type, and throws
		assert.throws(() => load_env(record(string), () => undefined), TypeError);
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

	test('format_issues() is format_issue of each issue', () => {
		const partial_env = new Map([['PORT', 'abc']]);
		const err = catch_env_error((key) => partial_env.get(key));
		assert.include(err.format_issues(), 'PORT: expected decimal digits, received string');
		assert.strictEqual(err.format_issues().length, err.issues.length);
	});

	test('the message is unchanged', () => {
		assert.strictEqual(catch_env_error(() => undefined).message, 'Environment validation failed');
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
