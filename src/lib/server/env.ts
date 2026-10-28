/**
 * Base server environment schema and validation.
 *
 * Provides `BaseServerEnv` — a shared Zod schema for common server env vars
 * that apps can use directly or extend with app-specific fields.
 *
 * Generic env loading lives in `env/load.ts`.
 *
 * @module
 */

import { z } from 'zod';

import { create_keyring, type Keyring } from '../auth/keyring.ts';
import { format_allowed_origins_error, parse_allowed_origins } from '../http/origin.ts';

/**
 * Base Zod schema for server environment variables.
 *
 * Declares only what the spine reads — server config, database, cookie keys,
 * allowed origins, and the bootstrap token path — matching the Rust spine's
 * `BaseServerEnv`. Anything else (fact storage, X-Accel delivery, public
 * URLs) is the app's own var: extend with app-specific fields via `.extend()`.
 */
export const BaseServerEnv = z.strictObject({
	NODE_ENV: z.enum(['development', 'production']).meta({ description: 'Runtime environment mode' }),
	PORT: z.coerce
		.number()
		.int()
		.min(1)
		.max(65535)
		.default(4040)
		.meta({ description: 'HTTP server port' }),
	HOST: z.string().default('localhost').meta({ description: 'HTTP server bind address' }),
	DATABASE_URL: z.string().min(1).meta({
		description: 'Database URL (postgres://, file://, or memory://)',
		sensitivity: 'secret'
	}),
	SECRET_FUZ_COOKIE_KEYS: z.string().min(32).meta({
		description: 'Cookie signing keys, separated by __ for rotation',
		sensitivity: 'secret'
	}),
	FUZ_ALLOWED_ORIGINS: z.string().min(1, 'FUZ_ALLOWED_ORIGINS is required').meta({
		description: 'Comma-separated origin patterns for API verification'
	}),
	FUZ_BOOTSTRAP_TOKEN_PATH: z
		.string()
		.optional()
		.meta({ description: 'Path to one-shot admin bootstrap token', sensitivity: 'secret' })
});
export type BaseServerEnv = z.infer<typeof BaseServerEnv>;

/**
 * Validated server env config — the artifacts `create_app_server()` needs.
 */
export interface ServerEnvOptions {
	ok: true;
	keyring: Keyring;
	allowed_origins: Array<RegExp>;
	bootstrap_token_path: string | null;
}

/**
 * Error from `validate_server_env` — keyring or origin validation failed.
 */
export interface ServerEnvOptionsError {
	ok: false;
	field: 'SECRET_FUZ_COOKIE_KEYS' | 'FUZ_ALLOWED_ORIGINS';
	errors: Array<string>;
}

export type ServerEnvOptionsResult = ServerEnvOptions | ServerEnvOptionsError;

/**
 * Validate a loaded `BaseServerEnv` and produce the artifacts needed for server init.
 *
 * Handles keyring validation, origin parsing (every refused allowlist entry is
 * reported, each on its own line), and bootstrap token path extraction.
 * Returns a Result so callers handle errors their own way (exit, logging, etc).
 *
 * @param env - a loaded and Zod-validated `BaseServerEnv`
 * @returns `{ok: true, keyring, allowed_origins, bootstrap_token_path}` or `{ok: false, field, errors}`
 */
export const validate_server_env = (env: BaseServerEnv): ServerEnvOptionsResult => {
	const keyring_result = create_keyring(env.SECRET_FUZ_COOKIE_KEYS);
	if (!keyring_result.ok) {
		return { ok: false, field: 'SECRET_FUZ_COOKIE_KEYS', errors: keyring_result.errors };
	}
	const origins_result = parse_allowed_origins(env.FUZ_ALLOWED_ORIGINS);
	if (!origins_result.ok) {
		return {
			ok: false,
			field: 'FUZ_ALLOWED_ORIGINS',
			errors: origins_result.errors.map(format_allowed_origins_error)
		};
	}
	return {
		ok: true,
		keyring: keyring_result.keyring,
		allowed_origins: origins_result.origins,
		bootstrap_token_path: env.FUZ_BOOTSTRAP_TOKEN_PATH ?? null
	};
};
