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

import {z} from 'zod';

import {create_validated_keyring, type Keyring} from '../auth/keyring.js';
import {parse_allowed_origins} from '../http/origin.js';

/**
 * Base Zod schema for server environment variables.
 *
 * Provides the common fields used by fuz apps:
 * server config, database, auth, security, public URLs, and SMTP.
 *
 * Apps can use directly or extend with app-specific fields via `.extend()`.
 */
export const BaseServerEnv = z.strictObject({
	NODE_ENV: z.enum(['development', 'production']).meta({description: 'Runtime environment mode'}),
	PORT: z.coerce.number().default(4040).meta({description: 'HTTP server port'}),
	HOST: z.string().default('localhost').meta({description: 'HTTP server bind address'}),
	DATABASE_URL: z.string().min(1).meta({
		description: 'Database URL (postgres://, file://, or memory://)',
		sensitivity: 'secret',
	}),
	SECRET_COOKIE_KEYS: z.string().min(32).meta({
		description: 'Cookie signing keys, separated by __ for rotation',
		sensitivity: 'secret',
	}),
	ALLOWED_ORIGINS: z.string().min(1, 'ALLOWED_ORIGINS is required').meta({
		description: 'Comma-separated origin patterns for API verification',
	}),
	PUBLIC_API_URL: z.string().default('/api').meta({description: 'Public API base URL'}),
	PUBLIC_WEBSOCKET_URL: z.string().optional().meta({description: 'Public WebSocket URL'}),
	PUBLIC_CONTACT_EMAIL: z
		.union([z.email(), z.literal('')])
		.optional()
		.meta({description: 'Public contact email address'}),
	BOOTSTRAP_TOKEN_PATH: z
		.string()
		.optional()
		.meta({description: 'Path to one-shot admin bootstrap token', sensitivity: 'secret'}),
	SMTP_HOST: z.string().optional().meta({description: 'SMTP server hostname'}),
	SMTP_USER: z
		.union([z.email(), z.literal('')])
		.optional()
		.meta({description: 'SMTP authentication username'}),
	SMTP_PASSWORD: z
		.string()
		.optional()
		.meta({description: 'SMTP authentication password', sensitivity: 'secret'}),
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
	field: 'SECRET_COOKIE_KEYS' | 'ALLOWED_ORIGINS';
	errors: Array<string>;
}

export type ServerEnvOptionsResult = ServerEnvOptions | ServerEnvOptionsError;

/**
 * Validate a loaded `BaseServerEnv` and produce the artifacts needed for server init.
 *
 * Handles keyring validation, origin parsing, and bootstrap token path extraction.
 * Returns a Result so callers handle errors their own way (exit, logging, etc).
 *
 * @param env - a loaded and Zod-validated `BaseServerEnv`
 * @returns `{ok: true, keyring, allowed_origins, bootstrap_token_path}` or `{ok: false, field, errors}`
 */
export const validate_server_env = (env: BaseServerEnv): ServerEnvOptionsResult => {
	const keyring_result = create_validated_keyring(env.SECRET_COOKIE_KEYS);
	if (!keyring_result.ok) {
		return {ok: false, field: 'SECRET_COOKIE_KEYS', errors: keyring_result.errors};
	}
	let allowed_origins: Array<RegExp>;
	try {
		allowed_origins = parse_allowed_origins(env.ALLOWED_ORIGINS);
	} catch (err) {
		return {
			ok: false,
			field: 'ALLOWED_ORIGINS',
			errors: [err instanceof Error ? err.message : 'Invalid ALLOWED_ORIGINS'],
		};
	}
	if (allowed_origins.length === 0) {
		return {
			ok: false,
			field: 'ALLOWED_ORIGINS',
			errors: ['ALLOWED_ORIGINS contains no valid patterns'],
		};
	}
	return {
		ok: true,
		keyring: keyring_result.keyring,
		allowed_origins,
		bootstrap_token_path: env.BOOTSTRAP_TOKEN_PATH ?? null,
	};
};
