/**
 * Bootstrap route spec for first-time account creation.
 *
 * One-shot endpoint: exchanges a bootstrap token + credentials for
 * an account with keeper privileges and a session cookie.
 *
 * @module
 */

import type {Context} from 'hono';
import {to_error_message} from '@fuzdev/fuz_util/error.ts';
import type {Logger} from '@fuzdev/fuz_util/log.ts';

import type {SessionOptions} from './session_cookie.ts';
import {create_session_and_set_cookie} from './session_middleware.ts';
import {bootstrap_account, type BootstrapAccountSuccess} from './bootstrap_account.ts';
import {bootstrap_route_shape, type BootstrapInput} from './bootstrap_route_schema.ts';
import type {Db} from '../db/db.ts';
import {get_route_input, type RouteSpec} from '../http/route_spec.ts';
import {get_client_ip} from '../http/client_ip.ts';
import {rate_limit_exceeded_response, type RateLimiter} from '../rate_limiter.ts';
import type {RouteFactoryDeps} from './deps.ts';
import type {StatResult} from '../runtime/deps.ts';
import {ERROR_ALREADY_BOOTSTRAPPED} from '../http/error_schemas.ts';

/**
 * Bootstrap status — runtime state computed once at startup.
 */
export interface BootstrapStatus {
	available: boolean;
	token_path: string | null;
}

/**
 * Per-factory configuration for bootstrap route specs.
 *
 * `bootstrap_status` is runtime state (a mutable ref), not a dep or options value —
 * it is passed through so the route handler can flip it on success.
 */
export interface BootstrapRouteOptions {
	session_options: SessionOptions<string>;
	/** Shared mutable reference — flipped to false after successful bootstrap. */
	bootstrap_status: BootstrapStatus;
	/**
	 * Called after successful bootstrap (account + session created).
	 * Use for app-specific post-bootstrap work like generating API tokens.
	 */
	on_bootstrap?: (result: BootstrapAccountSuccess, c: Context) => Promise<void>;
	/** Rate limiter for bootstrap attempts (per-IP). Pass `null` to disable. */
	ip_rate_limiter: RateLimiter | null;
}

/**
 * Dependencies for checking bootstrap status at startup.
 */
export interface CheckBootstrapStatusDeps {
	stat: (path: string) => Promise<StatResult | null>;
	db: Db;
	log: Logger;
}

/**
 * Check bootstrap availability at startup.
 *
 * Bootstrap is available when:
 * 1. A token path is configured
 * 2. The token file exists on disk
 * 3. The `bootstrap_lock` table shows `bootstrapped = false`
 *
 * @param deps - filesystem and database access for the check
 * @param options - static configuration including `token_path`
 * @returns an object with `available` (boolean) and `token_path` (string | null)
 */
export const check_bootstrap_status = async (
	deps: CheckBootstrapStatusDeps,
	options: {token_path: string | null},
): Promise<BootstrapStatus> => {
	const {stat, db, log} = deps;
	const {token_path} = options;

	if (!token_path) {
		return {available: false, token_path: null};
	}

	const token_stat = await stat(token_path);
	if (token_stat === null) {
		log.info('Bootstrap unavailable: token file not found');
		return {available: false, token_path};
	}

	const lock_row = await db.query_one<{bootstrapped: boolean}>(
		'SELECT bootstrapped FROM bootstrap_lock WHERE id = 1',
	);
	if (lock_row?.bootstrapped) {
		log.info('Bootstrap unavailable: already bootstrapped');
		return {available: false, token_path};
	}

	log.info(`Bootstrap token available: ${token_path}`);
	return {available: true, token_path};
};

/**
 * Create bootstrap route specs for first-time account creation.
 *
 * @param deps - stateless capabilities including filesystem access
 * @param options - per-factory configuration (session, token path, bootstrap status)
 * @returns route specs (not yet applied to Hono)
 */
export const create_bootstrap_route_specs = (
	deps: RouteFactoryDeps,
	options: BootstrapRouteOptions,
): Array<RouteSpec> => {
	const {keyring} = deps;
	const {session_options, bootstrap_status, on_bootstrap, ip_rate_limiter} = options;
	const {token_path} = bootstrap_status;

	return [
		{
			...bootstrap_route_shape,
			handler: async (c, route) => {
				// Short-circuit if bootstrap already completed or surface-only mounted.
				// In 'surface_only' mode `bootstrap_status.token_path === null` and
				// `available === false`; in 'live' mode after success `available` flips
				// to `false`. Either way the wire shape is 403 ALREADY_BOOTSTRAPPED.
				if (!bootstrap_status.available || token_path === null) {
					return c.json({error: ERROR_ALREADY_BOOTSTRAPPED}, 403);
				}

				// Per-IP rate limit check (before any token/DB work)
				const ip = ip_rate_limiter ? get_client_ip(c) : null;
				if (ip_rate_limiter && ip) {
					const check = ip_rate_limiter.check(ip);
					if (!check.allowed) {
						return rate_limit_exceeded_response(c, check.retry_after);
					}
				}

				const input = get_route_input<BootstrapInput>(c);

				// `transaction: false` makes `route.db` the pool. `bootstrap_account`
				// manages its own transaction internally.
				const result = await bootstrap_account(
					{
						db: route.db,
						token_path,
						read_text_file: deps.read_text_file,
						delete_file: deps.delete_file,
						password: deps.password,
						log: deps.log,
					},
					input.token,
					input,
				);
				if (!result.ok) {
					if (ip_rate_limiter && ip) ip_rate_limiter.record(ip);
					deps.audit.emit(route, {
						event_type: 'bootstrap',
						outcome: 'failure',
						ip: get_client_ip(c),
						metadata: {error: result.error},
					});
					return c.json({error: result.error}, result.status);
				}

				// Successful bootstrap — update state immediately
				if (ip_rate_limiter && ip) ip_rate_limiter.reset(ip);
				bootstrap_status.available = false;

				await create_session_and_set_cookie({
					keyring,
					deps: {db: route.db},
					c,
					account_id: result.account.id,
					session_options,
				});

				if (on_bootstrap) {
					try {
						await on_bootstrap(result, c);
					} catch (err) {
						deps.log.error(`on_bootstrap callback failed: ${to_error_message(err)}`);
					}
				}

				deps.audit.emit(route, {
					event_type: 'bootstrap',
					actor_id: result.actor.id,
					account_id: result.account.id,
					ip: get_client_ip(c),
				});

				// CRITICAL: If token file deletion failed, throw to force operator attention.
				// All success work (session, on_bootstrap, audit) has completed above.
				// The error response alerts the operator to delete the token file manually.
				if (!result.token_file_deleted) {
					throw new Error(
						`Bootstrap succeeded but token file was not deleted at ${
							token_path
						}. Delete it manually and log in.`,
					);
				}

				return c.json({
					ok: true,
					account: {id: result.account.id, username: result.account.username},
					actor: {id: result.actor.id},
				});
			},
		},
	];
};
