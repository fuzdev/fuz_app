/**
 * Daemon token rotation, persistence, and middleware.
 *
 * Manages the lifecycle of filesystem-resident daemon tokens: writing to disk,
 * rotation on an interval, and HTTP middleware for authentication.
 *
 * Pure token primitives (schema, generation, validation) live in `daemon_token.ts`.
 * See docs/identity.md for design rationale.
 *
 * @module
 */

import type {MiddlewareHandler} from 'hono';
import type {Logger} from '@fuzdev/fuz_util/log.js';

import {type FsWriteDeps, type FsRemoveDeps, type EnvDeps} from '../runtime/deps.js';
import {write_file_atomic} from '../runtime/fs.js';
import {get_app_dir} from '../cli/config.js';
import {REQUEST_CONTEXT_KEY, build_request_context} from './request_context.js';
import {CREDENTIAL_TYPE_KEY} from '../hono_context.js';
import {
	ERROR_INVALID_DAEMON_TOKEN,
	ERROR_KEEPER_ACCOUNT_NOT_CONFIGURED,
	ERROR_KEEPER_ACCOUNT_NOT_FOUND,
} from '../http/error_schemas.js';
import {query_permit_find_account_id_for_role} from './permit_queries.js';
import type {QueryDeps} from '../db/query_deps.js';
import {ROLE_KEEPER} from './role_schema.js';
import {
	DaemonToken,
	DAEMON_TOKEN_HEADER,
	generate_daemon_token,
	validate_daemon_token,
	type DaemonTokenState,
} from './daemon_token.js';

/** Default rotation interval in milliseconds (30 seconds). */
export const DEFAULT_ROTATION_INTERVAL_MS = 30_000;

/** Deps for writing the daemon token to disk. */
export type DaemonTokenWriteDeps = Pick<EnvDeps, 'env_get'> &
	FsWriteDeps & {
		/** Set file permissions. Optional — consumers provide when available (e.g. `Deno.chmod`). */
		chmod?: (path: string, mode: number) => Promise<void>;
	};

/**
 * Get the daemon token file path (`~/.{name}/run/daemon_token`).
 *
 * @param runtime - runtime with `env_get` capability
 * @param name - application name
 * @returns path to `daemon_token`, or `null` if `$HOME` is not set
 */
export const get_daemon_token_path = (
	runtime: Pick<EnvDeps, 'env_get'>,
	name: string,
): string | null => {
	const app_dir = get_app_dir(runtime, name);
	return app_dir ? `${app_dir}/run/daemon_token` : null;
};

/**
 * Write the current token to disk atomically.
 *
 * Uses `write_file_atomic` (temp file + rename) and optionally sets mode 0600.
 *
 * @param runtime - runtime with file write capabilities
 * @param token_path - path to write the token
 * @param token - the raw token string
 */
export const write_daemon_token = async (
	runtime: DaemonTokenWriteDeps,
	token_path: string,
	token: string,
): Promise<void> => {
	await write_file_atomic(runtime, token_path, token + '\n');
	if (runtime.chmod) {
		await runtime.chmod(token_path, 0o600);
	}
};

/**
 * Resolve the keeper account ID by querying for the account with an active keeper permit.
 *
 * There is exactly one keeper account (the bootstrap account). Runs once at
 * server startup — the result is cached in `DaemonTokenState.keeper_account_id`.
 *
 * @param deps - query dependencies
 * @returns the keeper account ID, or `null` if no keeper exists yet (pre-bootstrap)
 */
export const resolve_keeper_account_id = async (deps: QueryDeps): Promise<string | null> => {
	return query_permit_find_account_id_for_role(deps, ROLE_KEEPER);
};

/** Options for daemon token rotation. */
export interface DaemonTokenRotationOptions {
	/** Application name (for `~/.{name}/run/daemon_token`). */
	app_name: string;
	/** Rotation interval in ms. Default: `30000` (30s). */
	rotation_interval_ms?: number;
}

/** Result of starting daemon token rotation. */
export interface DaemonTokenRotation {
	/** The mutable runtime state. Pass to `create_daemon_token_middleware`. */
	state: DaemonTokenState;
	/** Stop rotation, clean up the interval, and delete the token file. Call on graceful shutdown. */
	stop: () => Promise<void>;
}

/**
 * Start daemon token rotation.
 *
 * Generates an initial token, writes it to disk, resolves the keeper account,
 * and sets up periodic rotation. Returns the mutable state object and a stop function.
 *
 * @param runtime - runtime with file, env, and remove capabilities
 * @param deps - query dependencies for resolving keeper account
 * @param options - rotation configuration
 * @param log - the logger instance
 * @returns rotation state and stop function
 */
export const start_daemon_token_rotation = async (
	runtime: DaemonTokenWriteDeps & FsRemoveDeps,
	deps: QueryDeps,
	options: DaemonTokenRotationOptions,
	log: Logger,
): Promise<DaemonTokenRotation> => {
	const {app_name, rotation_interval_ms = DEFAULT_ROTATION_INTERVAL_MS} = options;

	const token_path = get_daemon_token_path(runtime, app_name);
	if (!token_path) {
		throw new Error('$HOME not set — cannot determine daemon token path');
	}

	// ensure run directory exists
	const app_dir = get_app_dir(runtime, app_name);
	if (app_dir) {
		await runtime.mkdir(`${app_dir}/run`, {recursive: true});
	}

	// resolve keeper account (may be null pre-bootstrap)
	const keeper_account_id = await resolve_keeper_account_id(deps);

	// generate initial token and write to disk
	const initial_token = generate_daemon_token();
	await write_daemon_token(runtime, token_path, initial_token);

	const state: DaemonTokenState = {
		current_token: initial_token,
		previous_token: null,
		rotated_at: new Date(),
		keeper_account_id,
	};

	let writing = false;

	const interval_id = setInterval(async () => {
		if (writing) return; // skip if previous rotation write still in progress
		writing = true;
		try {
			const new_token = generate_daemon_token();
			state.previous_token = state.current_token;
			state.current_token = new_token;
			state.rotated_at = new Date();
			await write_daemon_token(runtime, token_path, new_token);
		} catch (err) {
			log.error('Failed to write rotated token:', err);
		} finally {
			writing = false;
		}
	}, rotation_interval_ms);

	const stop = async (): Promise<void> => {
		clearInterval(interval_id);
		try {
			await runtime.remove(token_path);
		} catch {
			// already removed or never written
		}
	};

	return {state, stop};
};

/**
 * Create middleware that authenticates via daemon token.
 *
 * Checks the `X-Daemon-Token` header. Behavior:
 * - No header: pass through (don't touch existing context)
 * - Header present + valid: build `RequestContext` from keeper account,
 *   set `credential_type: 'daemon_token'` (overrides any existing session/bearer context)
 * - Header present + invalid: return 401 (fail-closed, no downgrade)
 * - Header present + valid but `keeper_account_id` is null: return 503
 *
 * @param state - the daemon token runtime state
 * @param deps - query dependencies (pool-level db for middleware)
 */
export const create_daemon_token_middleware = (
	state: DaemonTokenState,
	deps: QueryDeps,
): MiddlewareHandler => {
	return async (c, next): Promise<Response | void> => {
		const token_header = c.req.header(DAEMON_TOKEN_HEADER);

		if (!token_header) {
			await next();
			return;
		}

		// Zod-validate the token format at the I/O boundary
		const parse_result = DaemonToken.safeParse(token_header);
		if (!parse_result.success) {
			return c.json({error: ERROR_INVALID_DAEMON_TOKEN}, 401);
		}

		// fail-closed: header present but invalid token value
		if (!validate_daemon_token(parse_result.data, state)) {
			return c.json({error: ERROR_INVALID_DAEMON_TOKEN}, 401);
		}

		// daemon token valid — resolve keeper account
		if (!state.keeper_account_id) {
			return c.json({error: ERROR_KEEPER_ACCOUNT_NOT_CONFIGURED}, 503);
		}

		// build request context from the keeper account (overrides any existing session/bearer context)
		const ctx = await build_request_context(deps, state.keeper_account_id);
		if (!ctx) {
			return c.json({error: ERROR_KEEPER_ACCOUNT_NOT_FOUND}, 500);
		}

		c.set(REQUEST_CONTEXT_KEY, ctx);
		c.set(CREDENTIAL_TYPE_KEY, 'daemon_token');

		await next();
	};
};
