/**
 * Tests for server/env.ts — base server env schema and validation.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { get_meta, meta } from '@fuzdev/fuz_schema/meta.ts';
import {
	min_length,
	object,
	parse,
	parse_or_throw,
	pipe,
	string,
	type SchemaResult
} from '@fuzdev/fuz_schema/schema.ts';

import { BaseServerEnv, validate_server_env } from '#lib/server/env.ts';
import { env_schema_to_surface } from '#lib/http/surface.ts';
import { find_schema_sensitivity } from '#lib/sensitivity.ts';
import { parse_allowed_origins } from '#lib/http/origin.ts';
import { admit_origin_wildcards } from '#lib/http/origin_wildcard.ts';

/** Minimal valid env for BaseServerEnv (only required fields, no defaults). */
const VALID_ENV: Record<string, string> = {
	NODE_ENV: 'development',
	SECRET_FUZ_COOKIE_KEYS: 'a'.repeat(32),
	FUZ_ALLOWED_ORIGINS: 'http://localhost:5173',
	DATABASE_URL: 'memory://'
};

/** The fields `BaseServerEnv` marks `sensitivity: 'secret'`, sorted. */
const SECRET_FIELDS = ['DATABASE_URL', 'FUZ_BOOTSTRAP_TOKEN_PATH', 'SECRET_FUZ_COOKIE_KEYS'];

/** Parse `value` as a `BaseServerEnv`, throwing on failure. */
const parse_env = (value: unknown): BaseServerEnv => parse_or_throw(BaseServerEnv, value);

/** Parse `value` as a `BaseServerEnv`, returning the result. */
const safe_parse_env = (value: unknown): SchemaResult<BaseServerEnv> => parse(BaseServerEnv, value);

describe('BaseServerEnv', () => {
	test('parses minimal valid env with defaults', () => {
		const result = parse_env(VALID_ENV);
		assert.strictEqual(result.NODE_ENV, 'development');
		assert.strictEqual(result.PORT, 4040);
		assert.strictEqual(result.HOST, 'localhost');
		assert.strictEqual(result.DATABASE_URL, 'memory://');
		assert.strictEqual(result.FUZ_BOOTSTRAP_TOKEN_PATH, undefined);
	});

	test('declares only the vars the spine reads (the Rust BaseServerEnv set)', () => {
		assert.deepStrictEqual(Object.keys(BaseServerEnv.def).sort(), [
			'DATABASE_URL',
			'FUZ_ALLOWED_ORIGINS',
			'FUZ_ALLOW_ORIGIN_WILDCARDS',
			'FUZ_BOOTSTRAP_TOKEN_PATH',
			'FUZ_DB_AUDIT_CHECKOUT_TIMEOUT_MS',
			'FUZ_DB_CHECKOUT_TIMEOUT_MS',
			'HOST',
			'NODE_ENV',
			'PORT',
			'SECRET_FUZ_COOKIE_KEYS'
		]);
	});

	test('rejects app-owned vars the spine does not read (strict)', () => {
		for (const name of [
			'FUZ_FACTS_DIR',
			'FUZ_FACTS_X_ACCEL_REDIRECT_PREFIX',
			'PUBLIC_FUZ_API_URL',
			'SMTP_HOST'
		]) {
			const result = safe_parse_env({ ...VALID_ENV, [name]: '/x/' });
			assert.isFalse(result.ok, name);
		}
	});

	test('parses full env', () => {
		const result = parse_env({
			...VALID_ENV,
			PORT: '8080',
			HOST: '0.0.0.0',
			DATABASE_URL: 'https://example.com/db',
			FUZ_BOOTSTRAP_TOKEN_PATH: '/tmp/token'
		});
		assert.strictEqual(result.PORT, 8080);
		assert.strictEqual(result.HOST, '0.0.0.0');
		assert.strictEqual(result.DATABASE_URL, 'https://example.com/db');
		assert.strictEqual(result.FUZ_BOOTSTRAP_TOKEN_PATH, '/tmp/token');
	});

	test('reads PORT from a string to a number', () => {
		const result = parse_env({ ...VALID_ENV, PORT: '3000' });
		assert.strictEqual(result.PORT, 3000);
	});

	test('PORT is decimal digits from 1 to 65535, trimmed, one leading + allowed', () => {
		for (const [value, expected] of [
			['1', 1],
			['65535', 65535],
			[' 8080 ', 8080],
			['00080', 80],
			['+80', 80]
		] as const) {
			assert.strictEqual(parse_env({ ...VALID_ENV, PORT: value }).PORT, expected, value);
		}
		for (const value of ['', ' ', '0', '65536', '5e3', '0x1F90', '++80', '1.5', '-1', '80a']) {
			assert.isFalse(safe_parse_env({ ...VALID_ENV, PORT: value }).ok, JSON.stringify(value));
		}
	});

	test('a missing FUZ_ALLOWED_ORIGINS keeps its type issue, an empty one the custom message', () => {
		const empty = safe_parse_env({ ...VALID_ENV, FUZ_ALLOWED_ORIGINS: '' });
		assert.ok(!empty.ok);
		assert.strictEqual(empty.issues[0]!.message, 'FUZ_ALLOWED_ORIGINS is required');
		const { FUZ_ALLOWED_ORIGINS: _, ...without } = VALID_ENV;
		const missing = safe_parse_env(without);
		assert.ok(!missing.ok);
		assert.strictEqual(missing.issues[0]!.kind, 'string');
	});

	test('rejects unknown fields (strict)', () => {
		const result = safe_parse_env({
			...VALID_ENV,
			UNKNOWN_FIELD: 'hello'
		});
		assert.isFalse(result.ok);
	});

	test('rejects missing NODE_ENV', () => {
		const { NODE_ENV: _, ...without } = VALID_ENV;
		const result = safe_parse_env(without);
		assert.isFalse(result.ok);
	});

	test('rejects invalid NODE_ENV', () => {
		const result = safe_parse_env({ ...VALID_ENV, NODE_ENV: 'staging' });
		assert.isFalse(result.ok);
	});

	test('rejects short SECRET_FUZ_COOKIE_KEYS', () => {
		const result = safe_parse_env({
			...VALID_ENV,
			SECRET_FUZ_COOKIE_KEYS: 'short'
		});
		assert.isFalse(result.ok);
	});

	test('the pool checkout bounds read like PORT: unset, or whole ms from 1 to 600000', () => {
		for (const name of [
			'FUZ_DB_CHECKOUT_TIMEOUT_MS',
			'FUZ_DB_AUDIT_CHECKOUT_TIMEOUT_MS'
		] as const) {
			// unset is the backend's default (5 s / 30 s), applied by `create_app_backend`
			assert.strictEqual(parse_env(VALID_ENV)[name], undefined);
			for (const [value, expected] of [
				['250', 250],
				[' 250 ', 250],
				['1', 1],
				['600000', 600_000],
				['00080', 80]
			] as const) {
				assert.strictEqual(parse_env({ ...VALID_ENV, [name]: value })[name], expected);
			}
			// refused as the Rust twin's `trim().parse::<u64>()` refuses them, or out of range
			for (const value of ['0', '-1', 'abc', '600001', '', '  ', '1.5', '5e3', '0x1F90']) {
				const result = safe_parse_env({ ...VALID_ENV, [name]: value });
				assert.isFalse(result.ok, `${name}=${JSON.stringify(value)}`);
			}
		}
	});

	test('FUZ_ALLOW_ORIGIN_WILDCARDS is exactly true or false', () => {
		assert.strictEqual(parse_env(VALID_ENV).FUZ_ALLOW_ORIGIN_WILDCARDS, undefined);
		for (const value of ['true', 'false']) {
			const result = parse_env({ ...VALID_ENV, FUZ_ALLOW_ORIGIN_WILDCARDS: value });
			assert.strictEqual(result.FUZ_ALLOW_ORIGIN_WILDCARDS, value);
		}
		for (const value of ['', ' ', 'TRUE', 'True', '1', 'yes', 'on', ' true', 'true ', '0']) {
			const result = safe_parse_env({ ...VALID_ENV, FUZ_ALLOW_ORIGIN_WILDCARDS: value });
			assert.isFalse(result.ok, JSON.stringify(value));
		}
	});

	test('rejects empty FUZ_ALLOWED_ORIGINS', () => {
		const result = safe_parse_env({
			...VALID_ENV,
			FUZ_ALLOWED_ORIGINS: ''
		});
		assert.isFalse(result.ok);
	});

	test('rejects empty string for DATABASE_URL', () => {
		const result = safe_parse_env({ ...VALID_ENV, DATABASE_URL: '' });
		assert.isFalse(result.ok);
	});

	test('rejects missing DATABASE_URL', () => {
		const { DATABASE_URL: _, ...without } = VALID_ENV;
		const result = safe_parse_env(without);
		assert.isFalse(result.ok);
	});

	test('is extensible by spreading def', () => {
		const extended = object({
			...BaseServerEnv.def,
			ADMIN_TOKEN: pipe(string, min_length(10))
		});
		const result = parse(extended, {
			...VALID_ENV,
			ADMIN_TOKEN: 'long-enough-token'
		});
		assert.isTrue(result.ok);
	});

	test('every field has meta with a description', () => {
		for (const [name, field_schema] of Object.entries(BaseServerEnv.def)) {
			const field_meta = get_meta(field_schema);
			assert.ok(field_meta, `${name} should have meta`);
			assert.ok(field_meta.description, `${name} should have a description`);
		}
	});

	test('the secret fields carry sensitivity: secret', () => {
		const secret_fields: Array<string> = [];
		for (const [name, field_schema] of Object.entries(BaseServerEnv.def)) {
			if (get_meta(field_schema)?.sensitivity === 'secret') {
				secret_fields.push(name);
			}
		}
		assert.deepStrictEqual(secret_fields.sort(), SECRET_FIELDS);
	});

	test('the secret fields read secret through find_schema_sensitivity and the surface', () => {
		const by_reader = Object.entries(BaseServerEnv.def)
			.filter(([, field_schema]) => find_schema_sensitivity(field_schema) === 'secret')
			.map(([name]) => name);
		assert.deepStrictEqual(by_reader.sort(), SECRET_FIELDS);
		const by_surface = env_schema_to_surface(BaseServerEnv)
			.filter((e) => e.sensitivity === 'secret')
			.map((e) => e.name);
		assert.deepStrictEqual(by_surface.sort(), SECRET_FIELDS);
	});

	test('spreading def preserves parent field metadata', () => {
		const extended = object({
			...BaseServerEnv.def,
			CUSTOM: meta(string, { description: 'Custom field' })
		});
		assert.strictEqual(get_meta(extended.def.PORT)?.description, 'HTTP server port');
		assert.strictEqual(get_meta(extended.def.CUSTOM)?.description, 'Custom field');
	});
});

describe('env_schema_to_surface', () => {
	test('returns one entry per BaseServerEnv field', () => {
		const entries = env_schema_to_surface(BaseServerEnv);
		assert.deepStrictEqual(
			entries.map((e) => e.name),
			Object.keys(BaseServerEnv.def)
		);
	});

	test('optional fields detected correctly', () => {
		const entries = env_schema_to_surface(BaseServerEnv);
		const optional_names = entries.filter((e) => e.optional).map((e) => e.name);
		assert.notInclude(optional_names, 'DATABASE_URL');
		assert.include(optional_names, 'FUZ_BOOTSTRAP_TOKEN_PATH');
	});

	test('default fields detected correctly', () => {
		const entries = env_schema_to_surface(BaseServerEnv);
		const default_names = entries.filter((e) => e.has_default).map((e) => e.name);
		assert.include(default_names, 'PORT');
		assert.include(default_names, 'HOST');
	});

	test('required non-default fields detected correctly', () => {
		const entries = env_schema_to_surface(BaseServerEnv);
		const required_no_default = entries
			.filter((e) => !e.optional && !e.has_default)
			.map((e) => e.name);
		assert.include(required_no_default, 'NODE_ENV');
		assert.include(required_no_default, 'SECRET_FUZ_COOKIE_KEYS');
		assert.include(required_no_default, 'FUZ_ALLOWED_ORIGINS');
		assert.include(required_no_default, 'DATABASE_URL');
	});

	test('descriptions come from meta', () => {
		const entries = env_schema_to_surface(BaseServerEnv);
		const port_entry = entries.find((e) => e.name === 'PORT')!;
		assert.strictEqual(port_entry.description, 'HTTP server port');
	});

	test('sensitivity comes from meta', () => {
		const entries = env_schema_to_surface(BaseServerEnv);
		const secret_names = entries.filter((e) => e.sensitivity === 'secret').map((e) => e.name);
		assert.include(secret_names, 'SECRET_FUZ_COOKIE_KEYS');
		assert.include(secret_names, 'DATABASE_URL');
		const port_entry = entries.find((e) => e.name === 'PORT')!;
		assert.strictEqual(port_entry.sensitivity, null);
	});
});

describe('validate_server_env', () => {
	test('valid env returns ok with keyring, allowed_origins, bootstrap_token_path', () => {
		const env = parse_env({
			...VALID_ENV,
			FUZ_BOOTSTRAP_TOKEN_PATH: '/tmp/token'
		});
		const result = validate_server_env(env);
		assert.isTrue(result.ok);
		assert.isObject(result.keyring);
		assert.isFunction(result.keyring.sign);
		assert.isFunction(result.keyring.verify);
		assert.isArray(result.allowed_origins);
		assert.isAbove(result.allowed_origins.length, 0);
		assert.strictEqual(result.bootstrap_token_path, '/tmp/token');
		assert.isFalse(result.allow_origin_wildcards);
	});

	test('the wildcard opt-in reads through to allow_origin_wildcards', () => {
		for (const [value, expected] of [
			[undefined, false],
			['false', false],
			['true', true]
		] as const) {
			const env = parse_env({
				...VALID_ENV,
				...(value === undefined ? {} : { FUZ_ALLOW_ORIGIN_WILDCARDS: value })
			});
			const result = validate_server_env(env);
			assert.ok(result.ok);
			assert.strictEqual(result.allow_origin_wildcards, expected, String(value));
		}
	});

	test('a wildcard entry without the opt-in is refused, as create_app_server would', () => {
		for (const value of [undefined, 'false'] as const) {
			const env = parse_env({
				...VALID_ENV,
				FUZ_ALLOWED_ORIGINS: 'http://localhost:5173, http://localhost:*',
				...(value === undefined ? {} : { FUZ_ALLOW_ORIGIN_WILDCARDS: value })
			});
			const result = validate_server_env(env);
			assert.ok(!result.ok);
			assert.strictEqual(result.field, 'FUZ_ALLOWED_ORIGINS');
			const refusal = admit_origin_wildcards(
				parse_origins('http://localhost:5173, http://localhost:*'),
				false
			);
			assert.ok(!refusal.ok);
			assert.deepStrictEqual(result.errors, [refusal.message]);
			assert.ok(
				refusal.message.startsWith('FUZ_ALLOWED_ORIGINS holds a wildcard entry'),
				refusal.message
			);
		}
	});

	test('invalid cookie keys returns error with field', () => {
		const env = parse_env({
			...VALID_ENV
			// a key valid for the schema (min 32 chars) but not for the keyring, which validates differently
		});
		// force an env with short keys past the schema (simulate runtime scenario)
		const bad_env = { ...env, SECRET_FUZ_COOKIE_KEYS: 'short' };
		const result = validate_server_env(bad_env);
		assert.isFalse(result.ok);
		assert.strictEqual(result.field, 'SECRET_FUZ_COOKIE_KEYS');
		assert.isArray(result.errors);
		assert.isAbove(result.errors.length, 0);
	});

	test('missing FUZ_BOOTSTRAP_TOKEN_PATH returns null', () => {
		const env = parse_env(VALID_ENV);
		const result = validate_server_env(env);
		assert.isTrue(result.ok);
		assert.isNull(result.bootstrap_token_path);
	});

	test('comma-only FUZ_ALLOWED_ORIGINS returns error', () => {
		const env = parse_env(VALID_ENV);
		const bad_env = { ...env, FUZ_ALLOWED_ORIGINS: ',,,' };
		const result = validate_server_env(bad_env);
		assert.isFalse(result.ok);
		assert.strictEqual(result.field, 'FUZ_ALLOWED_ORIGINS');
		assert.isAbove(result.errors.length, 0);
	});

	test('invalid origin pattern returns error', () => {
		const env = parse_env(VALID_ENV);
		const bad_env = { ...env, FUZ_ALLOWED_ORIGINS: 'not-a-valid-origin' };
		const result = validate_server_env(bad_env);
		assert.isFalse(result.ok);
		assert.strictEqual(result.field, 'FUZ_ALLOWED_ORIGINS');
		assert.isAbove(result.errors.length, 0);
	});

	test('multiple origin patterns produce correct array length', () => {
		const env = parse_env({
			...VALID_ENV,
			FUZ_ALLOWED_ORIGINS: 'http://localhost:*,https://example.com,https://*.fuz.dev',
			FUZ_ALLOW_ORIGIN_WILDCARDS: 'true'
		});
		const result = validate_server_env(env);
		assert.isTrue(result.ok);
		assert.strictEqual(result.allowed_origins.length, 3);
	});
});

/** The matchers `parse_allowed_origins` builds for `raw`. */
const parse_origins = (raw: string): Array<RegExp> => {
	const result = parse_allowed_origins(raw);
	if (!result.ok) throw new Error(raw);
	return result.origins;
};
