/**
 * Tests for server/env.ts — base server env schema and validation.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';
import {z} from 'zod';

import {BaseServerEnv, validate_server_env} from '$lib/server/env.js';
import {env_schema_to_surface} from '$lib/http/surface.js';
import type {SchemaFieldMeta} from '$lib/schema_meta.js';

/** Minimal valid env for BaseServerEnv (only required fields, no defaults). */
const VALID_ENV: Record<string, string> = {
	NODE_ENV: 'development',
	SECRET_COOKIE_KEYS: 'a'.repeat(32),
	ALLOWED_ORIGINS: 'http://localhost:*',
	DATABASE_URL: 'memory://',
};

describe('BaseServerEnv', () => {
	test('parses minimal valid env with defaults', () => {
		const result = BaseServerEnv.parse(VALID_ENV);
		assert.strictEqual(result.NODE_ENV, 'development');
		assert.strictEqual(result.PORT, 4040);
		assert.strictEqual(result.HOST, 'localhost');
		assert.strictEqual(result.PUBLIC_API_URL, '/api');
		assert.strictEqual(result.DATABASE_URL, 'memory://');
		assert.strictEqual(result.PUBLIC_WEBSOCKET_URL, undefined);
		assert.strictEqual(result.SMTP_HOST, undefined);
	});

	test('parses full env', () => {
		const result = BaseServerEnv.parse({
			...VALID_ENV,
			PORT: '8080',
			HOST: '0.0.0.0',
			DATABASE_URL: 'https://example.com/db',
			PUBLIC_API_URL: '/api/v2',
			PUBLIC_WEBSOCKET_URL: 'wss://example.com',
			PUBLIC_CONTACT_EMAIL: 'test@example.com',
			SMTP_HOST: 'smtp.example.com',
			SMTP_USER: 'noreply@example.com',
			SMTP_PASSWORD: 'secret',
		});
		assert.strictEqual(result.PORT, 8080);
		assert.strictEqual(result.HOST, '0.0.0.0');
		assert.strictEqual(result.DATABASE_URL, 'https://example.com/db');
		assert.strictEqual(result.PUBLIC_API_URL, '/api/v2');
		assert.strictEqual(result.SMTP_HOST, 'smtp.example.com');
		assert.strictEqual(result.SMTP_USER, 'noreply@example.com');
	});

	test('coerces PORT from string to number', () => {
		const result = BaseServerEnv.parse({...VALID_ENV, PORT: '3000'});
		assert.strictEqual(result.PORT, 3000);
	});

	test('rejects unknown fields (strict)', () => {
		const result = BaseServerEnv.safeParse({
			...VALID_ENV,
			UNKNOWN_FIELD: 'hello',
		});
		assert.isFalse(result.success);
	});

	test('rejects missing NODE_ENV', () => {
		const {NODE_ENV: _, ...without} = VALID_ENV;
		const result = BaseServerEnv.safeParse(without);
		assert.isFalse(result.success);
	});

	test('rejects invalid NODE_ENV', () => {
		const result = BaseServerEnv.safeParse({...VALID_ENV, NODE_ENV: 'staging'});
		assert.isFalse(result.success);
	});

	test('rejects short SECRET_COOKIE_KEYS', () => {
		const result = BaseServerEnv.safeParse({
			...VALID_ENV,
			SECRET_COOKIE_KEYS: 'short',
		});
		assert.isFalse(result.success);
	});

	test('rejects empty ALLOWED_ORIGINS', () => {
		const result = BaseServerEnv.safeParse({
			...VALID_ENV,
			ALLOWED_ORIGINS: '',
		});
		assert.isFalse(result.success);
	});

	test('rejects empty string for DATABASE_URL', () => {
		const result = BaseServerEnv.safeParse({...VALID_ENV, DATABASE_URL: ''});
		assert.isFalse(result.success);
	});

	test('rejects missing DATABASE_URL', () => {
		const {DATABASE_URL: _, ...without} = VALID_ENV;
		const result = BaseServerEnv.safeParse(without);
		assert.isFalse(result.success);
	});

	test('allows empty string for PUBLIC_CONTACT_EMAIL', () => {
		const result = BaseServerEnv.parse({...VALID_ENV, PUBLIC_CONTACT_EMAIL: ''});
		assert.strictEqual(result.PUBLIC_CONTACT_EMAIL, '');
	});

	test('allows empty string for SMTP_USER', () => {
		const result = BaseServerEnv.parse({...VALID_ENV, SMTP_USER: ''});
		assert.strictEqual(result.SMTP_USER, '');
	});

	test('is extensible via .extend()', () => {
		const extended = BaseServerEnv.extend({
			ADMIN_TOKEN: z.string().min(10),
		});
		const result = extended.safeParse({
			...VALID_ENV,
			ADMIN_TOKEN: 'long-enough-token',
		});
		assert.isTrue(result.success);
	});

	test('all 13 fields have .meta() with description', () => {
		for (const [name, field_schema] of Object.entries(BaseServerEnv.shape)) {
			const meta = (field_schema as z.ZodType).meta() as {description?: string} | undefined;
			assert.ok(meta, `${name} should have .meta()`);
			assert.ok(meta.description, `${name} should have a description`);
		}
	});

	test('4 fields have sensitivity: secret', () => {
		const secret_fields: Array<string> = [];
		for (const [name, field_schema] of Object.entries(BaseServerEnv.shape)) {
			const meta = (field_schema as z.ZodType).meta() as SchemaFieldMeta | undefined;
			if (meta?.sensitivity === 'secret') {
				secret_fields.push(name);
			}
		}
		assert.deepStrictEqual(secret_fields.sort(), [
			'BOOTSTRAP_TOKEN_PATH',
			'DATABASE_URL',
			'SECRET_COOKIE_KEYS',
			'SMTP_PASSWORD',
		]);
	});

	test('.extend() preserves parent field metadata', () => {
		const extended = BaseServerEnv.extend({
			CUSTOM: z.string().meta({description: 'Custom field'}),
		});
		const port_meta = (extended.shape.PORT as z.ZodType).meta() as {description?: string};
		assert.strictEqual(port_meta.description, 'HTTP server port');
		const custom_meta = (extended.shape.CUSTOM as z.ZodType).meta() as {description?: string};
		assert.strictEqual(custom_meta.description, 'Custom field');
	});
});

describe('env_schema_to_surface', () => {
	test('returns 13 entries for BaseServerEnv', () => {
		const entries = env_schema_to_surface(BaseServerEnv);
		assert.strictEqual(entries.length, 13);
	});

	test('optional fields detected correctly', () => {
		const entries = env_schema_to_surface(BaseServerEnv);
		const optional_names = entries.filter((e) => e.optional).map((e) => e.name);
		assert.notInclude(optional_names, 'DATABASE_URL');
		assert.include(optional_names, 'SMTP_HOST');
		assert.include(optional_names, 'PUBLIC_WEBSOCKET_URL');
		assert.include(optional_names, 'BOOTSTRAP_TOKEN_PATH');
	});

	test('default fields detected correctly', () => {
		const entries = env_schema_to_surface(BaseServerEnv);
		const default_names = entries.filter((e) => e.has_default).map((e) => e.name);
		assert.include(default_names, 'PORT');
		assert.include(default_names, 'HOST');
		assert.include(default_names, 'PUBLIC_API_URL');
	});

	test('required non-default fields detected correctly', () => {
		const entries = env_schema_to_surface(BaseServerEnv);
		const required_no_default = entries
			.filter((e) => !e.optional && !e.has_default)
			.map((e) => e.name);
		assert.include(required_no_default, 'NODE_ENV');
		assert.include(required_no_default, 'SECRET_COOKIE_KEYS');
		assert.include(required_no_default, 'ALLOWED_ORIGINS');
		assert.include(required_no_default, 'DATABASE_URL');
	});

	test('descriptions come from .meta()', () => {
		const entries = env_schema_to_surface(BaseServerEnv);
		const port_entry = entries.find((e) => e.name === 'PORT')!;
		assert.strictEqual(port_entry.description, 'HTTP server port');
	});

	test('sensitivity comes from .meta()', () => {
		const entries = env_schema_to_surface(BaseServerEnv);
		const secret_names = entries.filter((e) => e.sensitivity === 'secret').map((e) => e.name);
		assert.include(secret_names, 'SECRET_COOKIE_KEYS');
		assert.include(secret_names, 'SMTP_PASSWORD');
		const port_entry = entries.find((e) => e.name === 'PORT')!;
		assert.strictEqual(port_entry.sensitivity, null);
	});
});

describe('validate_server_env', () => {
	test('valid env returns ok with keyring, allowed_origins, bootstrap_token_path', () => {
		const env = BaseServerEnv.parse({
			...VALID_ENV,
			BOOTSTRAP_TOKEN_PATH: '/tmp/token',
		});
		const result = validate_server_env(env);
		assert.isTrue(result.ok);
		assert.isObject(result.keyring);
		assert.isFunction(result.keyring.sign);
		assert.isFunction(result.keyring.verify);
		assert.isArray(result.allowed_origins);
		assert.isAbove(result.allowed_origins.length, 0);
		assert.strictEqual(result.bootstrap_token_path, '/tmp/token');
	});

	test('invalid cookie keys returns error with field', () => {
		const env = BaseServerEnv.parse({
			...VALID_ENV,
			// Override with a valid-for-zod but invalid-for-keyring key (min 32 chars for zod, but keyring validates differently)
		});
		// Force an env with short keys past Zod (simulate runtime scenario)
		const bad_env = {...env, SECRET_COOKIE_KEYS: 'short'};
		const result = validate_server_env(bad_env);
		assert.isFalse(result.ok);
		assert.strictEqual(result.field, 'SECRET_COOKIE_KEYS');
		assert.isArray(result.errors);
		assert.isAbove(result.errors.length, 0);
	});

	test('missing BOOTSTRAP_TOKEN_PATH returns null', () => {
		const env = BaseServerEnv.parse(VALID_ENV);
		const result = validate_server_env(env);
		assert.isTrue(result.ok);
		assert.isNull(result.bootstrap_token_path);
	});

	test('comma-only ALLOWED_ORIGINS returns error', () => {
		const env = BaseServerEnv.parse(VALID_ENV);
		const bad_env = {...env, ALLOWED_ORIGINS: ',,,'};
		const result = validate_server_env(bad_env);
		assert.isFalse(result.ok);
		assert.strictEqual(result.field, 'ALLOWED_ORIGINS');
		assert.isAbove(result.errors.length, 0);
	});

	test('invalid origin pattern returns error', () => {
		const env = BaseServerEnv.parse(VALID_ENV);
		const bad_env = {...env, ALLOWED_ORIGINS: 'not-a-valid-origin'};
		const result = validate_server_env(bad_env);
		assert.isFalse(result.ok);
		assert.strictEqual(result.field, 'ALLOWED_ORIGINS');
		assert.isAbove(result.errors.length, 0);
	});

	test('multiple origin patterns produce correct array length', () => {
		const env = BaseServerEnv.parse({
			...VALID_ENV,
			ALLOWED_ORIGINS: 'http://localhost:*,https://example.com,https://*.fuz.dev',
		});
		const result = validate_server_env(env);
		assert.isTrue(result.ok);
		assert.strictEqual(result.allowed_origins.length, 3);
	});
});
