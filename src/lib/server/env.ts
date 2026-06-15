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
	PORT: z.coerce
		.number()
		.int()
		.min(1)
		.max(65535)
		.default(4040)
		.meta({description: 'HTTP server port'}),
	HOST: z.string().default('localhost').meta({description: 'HTTP server bind address'}),
	DATABASE_URL: z.string().min(1).meta({
		description: 'Database URL (postgres://, file://, or memory://)',
		sensitivity: 'secret',
	}),
	SECRET_FUZ_COOKIE_KEYS: z.string().min(32).meta({
		description: 'Cookie signing keys, separated by __ for rotation',
		sensitivity: 'secret',
	}),
	FUZ_ALLOWED_ORIGINS: z.string().min(1, 'FUZ_ALLOWED_ORIGINS is required').meta({
		description: 'Comma-separated origin patterns for API verification',
	}),
	PUBLIC_FUZ_API_URL: z.string().default('/api').meta({description: 'Public API base URL'}),
	PUBLIC_FUZ_WEBSOCKET_URL: z.string().optional().meta({description: 'Public WebSocket URL'}),
	PUBLIC_FUZ_CONTACT_EMAIL: z
		.union([z.email(), z.literal('')])
		.optional()
		.meta({description: 'Public contact email address'}),
	FUZ_BOOTSTRAP_TOKEN_PATH: z
		.string()
		.optional()
		.meta({description: 'Path to one-shot admin bootstrap token', sensitivity: 'secret'}),
	SMTP_HOST: z.string().optional().meta({description: 'SMTP server hostname'}),
	// SMTP usernames are frequently not emails (SendGrid uses "apikey",
	// AWS SES / Postmark use token-style credentials), so validate as a plain
	// string — `z.email()` here would reject valid provider configs. Marked
	// `secret`: those token-style usernames are credentials (Postmark reuses
	// the server token as both user and password), so the value is masked in
	// the startup summary / logs like `SMTP_PASSWORD`.
	SMTP_USER: z
		.string()
		.optional()
		.meta({description: 'SMTP authentication username', sensitivity: 'secret'}),
	SMTP_PASSWORD: z
		.string()
		.optional()
		.meta({description: 'SMTP authentication password', sensitivity: 'secret'}),
	FUZ_FACTS_DIR: z.string().min(1).default('./.facts').meta({
		description: 'Directory for referenced (large) fact bytes, sharded <shard>/<rest>',
	}),
	FUZ_FACTS_X_ACCEL_REDIRECT_PREFIX: z.string().optional().meta({
		description: 'Internal nginx prefix for X-Accel-Redirect fact delivery (production only)',
	}),
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
 * Handles keyring validation, origin parsing, and bootstrap token path extraction.
 * Returns a Result so callers handle errors their own way (exit, logging, etc).
 *
 * @param env - a loaded and Zod-validated `BaseServerEnv`
 * @returns `{ok: true, keyring, allowed_origins, bootstrap_token_path}` or `{ok: false, field, errors}`
 */
export const validate_server_env = (env: BaseServerEnv): ServerEnvOptionsResult => {
	const keyring_result = create_validated_keyring(env.SECRET_FUZ_COOKIE_KEYS);
	if (!keyring_result.ok) {
		return {ok: false, field: 'SECRET_FUZ_COOKIE_KEYS', errors: keyring_result.errors};
	}
	let allowed_origins: Array<RegExp>;
	try {
		allowed_origins = parse_allowed_origins(env.FUZ_ALLOWED_ORIGINS);
	} catch (err) {
		return {
			ok: false,
			field: 'FUZ_ALLOWED_ORIGINS',
			errors: [err instanceof Error ? err.message : 'Invalid FUZ_ALLOWED_ORIGINS'],
		};
	}
	if (allowed_origins.length === 0) {
		return {
			ok: false,
			field: 'FUZ_ALLOWED_ORIGINS',
			errors: ['FUZ_ALLOWED_ORIGINS contains no valid patterns'],
		};
	}
	return {
		ok: true,
		keyring: keyring_result.keyring,
		allowed_origins,
		bootstrap_token_path: env.FUZ_BOOTSTRAP_TOKEN_PATH ?? null,
	};
};
