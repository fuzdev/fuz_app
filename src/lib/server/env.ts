/**
 * Base server environment schema and validation.
 *
 * Provides `BaseServerEnv` — a shared `@fuzdev/fuz_schema` object schema for
 * common server env vars that apps can use directly or extend with
 * app-specific fields.
 *
 * Generic env loading lives in `env/load.ts`, and the value schemas
 * (`env_integer`, `EnvStringbool`) in `env/env_schemas.ts`.
 *
 * @module
 */

import { meta } from '@fuzdev/fuz_schema/meta.ts';
import {
	message,
	min_length,
	object,
	one_of,
	optional,
	pipe,
	string,
	with_default,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';
import type { Result } from '@fuzdev/fuz_util/result.ts';

import { create_keyring, type Keyring } from '../auth/keyring.ts';
import { format_allowed_origins_error, parse_allowed_origins } from '../http/origin.ts';
import { admit_origin_wildcards } from '../http/origin_wildcard.ts';
import { DB_CHECKOUT_TIMEOUT_MAX_MS } from '../db/db_pg.ts';
import { env_integer } from '../env/env_schemas.ts';
// declares `sensitivity` on fuz_schema's `SchemaMeta`, for the fields here and consumers'
import '../sensitivity.ts';

/**
 * Base schema for server environment variables, a strict `object`.
 *
 * Declares only what the spine reads — server config, database and its pool
 * checkout bounds, cookie keys, allowed origins and the wildcard opt-in, and
 * the bootstrap token path — matching the Rust spine's `BaseServerEnv`. The
 * numeric vars read as the Rust twin reads them (`env_integer`: trimmed,
 * then decimal digits after at most one `+`, so `5e3` and a blank value are
 * refused on both, as is one out of range). Anything else (fact storage, X-Accel delivery, public
 * URLs) is the app's own var: extend by spreading `def` into a new `object`,
 * `object({...BaseServerEnv.def, MY_VAR: ...})`.
 *
 * Each field's description and `sensitivity` are `meta`, read by
 * `env_schema_to_surface`.
 */
export const BaseServerEnv = object({
	NODE_ENV: meta(one_of(['development', 'production']), {
		description: 'Runtime environment mode'
	}),
	PORT: meta(with_default(env_integer({ min: 1, max: 65535 }), 4040), {
		description: 'HTTP server port'
	}),
	HOST: meta(with_default(string, 'localhost'), { description: 'HTTP server bind address' }),
	DATABASE_URL: meta(pipe(string, min_length(1)), {
		description: 'Database URL (postgres://, file://, or memory://)',
		sensitivity: 'secret'
	}),
	SECRET_FUZ_COOKIE_KEYS: meta(pipe(string, min_length(32)), {
		description: 'Cookie signing keys, separated by __ for rotation',
		sensitivity: 'secret'
	}),
	FUZ_ALLOWED_ORIGINS: meta(
		pipe(string, message(min_length(1), 'FUZ_ALLOWED_ORIGINS is required')),
		{
			description: 'Comma-separated origin patterns for API verification'
		}
	),
	FUZ_ALLOW_ORIGIN_WILDCARDS: meta(optional(one_of(['true', 'false'])), {
		description:
			'Exactly `true` lets a wildcard FUZ_ALLOWED_ORIGINS entry (`:*`, a `*` label) boot, warned of on every boot; unset or `false` refuses one'
	}),
	FUZ_BOOTSTRAP_TOKEN_PATH: meta(optional(string), {
		description: 'Path to one-shot admin bootstrap token',
		sensitivity: 'secret'
	}),
	FUZ_DB_CHECKOUT_TIMEOUT_MS: meta(
		optional(env_integer({ min: 1, max: DB_CHECKOUT_TIMEOUT_MAX_MS })),
		{
			description:
				'Bound on the pool checkouts a request makes, in ms (default 5000); a failed checkout answers 503. Audit writes use FUZ_DB_AUDIT_CHECKOUT_TIMEOUT_MS instead, including the failed-login row a request waits on. Postgres only — PGlite and pglet have no pool'
		}
	),
	FUZ_DB_AUDIT_CHECKOUT_TIMEOUT_MS: meta(
		optional(env_integer({ min: 1, max: DB_CHECKOUT_TIMEOUT_MAX_MS })),
		{
			description:
				'Bound on the checkout behind each audit pool write, in ms (default 30000); a failed login waits on its row, so up to this bound. Postgres only'
		}
	)
});
export type BaseServerEnv = Infer<typeof BaseServerEnv>;

/**
 * Validated server env config — the artifacts `create_app_server()` needs.
 */
export interface ValidatedServerEnv {
	keyring: Keyring;
	allowed_origins: Array<RegExp>;
	/**
	 * `FUZ_ALLOW_ORIGIN_WILDCARDS=true` — pass to `create_app_server`'s
	 * `allow_origin_wildcards`, which refuses a wildcard entry without it.
	 */
	allow_origin_wildcards: boolean;
	bootstrap_token_path: string | null;
}

/**
 * Error from `validate_server_env` — keyring or origin validation failed.
 */
export interface ServerEnvValidationError {
	field: 'SECRET_FUZ_COOKIE_KEYS' | 'FUZ_ALLOWED_ORIGINS';
	errors: Array<string>;
}

/**
 * Validate a loaded `BaseServerEnv` and produce the artifacts needed for server init.
 *
 * Handles keyring validation, origin parsing (every refused allowlist entry is
 * reported, each on its own line), the wildcard opt-in (a wildcard entry
 * without `FUZ_ALLOW_ORIGIN_WILDCARDS=true` is refused with
 * `admit_origin_wildcards`' text, as `create_app_server` would), and
 * bootstrap token path extraction.
 * Returns a Result so callers handle errors their own way (exit, logging, etc).
 *
 * @param env - a loaded and validated `BaseServerEnv`
 * @returns `{ok: true, keyring, allowed_origins, allow_origin_wildcards, bootstrap_token_path}`
 *   or `{ok: false, field, errors}`
 */
export const validate_server_env = (
	env: BaseServerEnv
): Result<ValidatedServerEnv, ServerEnvValidationError> => {
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
	// refused here too, so an env-driven server fails before its backend
	// touches the DB (`create_app_server` repeats the check for direct callers)
	const allow_origin_wildcards = env.FUZ_ALLOW_ORIGIN_WILDCARDS === 'true';
	const wildcards = admit_origin_wildcards(origins_result.origins, allow_origin_wildcards);
	if (!wildcards.ok) {
		return { ok: false, field: 'FUZ_ALLOWED_ORIGINS', errors: [wildcards.message] };
	}
	return {
		ok: true,
		keyring: keyring_result.keyring,
		allowed_origins: origins_result.origins,
		allow_origin_wildcards,
		bootstrap_token_path: env.FUZ_BOOTSTRAP_TOKEN_PATH ?? null
	};
};
