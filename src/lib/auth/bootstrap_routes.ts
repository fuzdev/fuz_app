/**
 * Bootstrap route spec for first-time account creation.
 *
 * One-shot endpoint: exchanges a bootstrap token + credentials for
 * an account with keeper privileges and a session cookie.
 *
 * @module
 */

import { to_error_message } from '@fuzdev/fuz_util/error.ts';
import type { Logger } from '@fuzdev/fuz_util/log.ts';

import { session_cookie_header, type SessionOptions } from './session_cookie.ts';
import {
	bootstrap_account,
	read_bootstrap_token,
	type BootstrapAccountCreated
} from './bootstrap_account.ts';
import type { BootstrapTokenStore } from './bootstrap_token_store.ts';
import { bootstrap_route_shape } from './bootstrap_route_schema.ts';
import type { Db } from '../db/db.ts';
import { attach_route_handler, type RouteSpec } from '../http/route_spec.ts';
import { route_fail, route_ok } from '../http/route_result.ts';
import { rate_limit_ip_key } from '../http/ip_canonical.ts';
import { reserve_optional, type RateLimiter } from '../rate_limiter.ts';
import type { RouteFactoryDeps } from './deps.ts';
import {
	ERROR_ALREADY_BOOTSTRAPPED,
	ERROR_TOKEN_FILE_MISSING,
	ERROR_TOKEN_FILE_UNDELETABLE,
	REST_ALREADY_BOOTSTRAPPED,
	REST_INVALID_TOKEN,
	REST_RATE_LIMIT_EXCEEDED,
	REST_TOKEN_FILE_MISSING,
	REST_TOKEN_FILE_UNDELETABLE
} from '../http/error_schemas.ts';

/**
 * Bootstrap status — runtime state computed once at startup, flipped to
 * unavailable when the window closes.
 */
export interface BootstrapStatus {
	available: boolean;
}

/**
 * Called after a successful bootstrap has committed, with what it created.
 * Use for app-specific post-bootstrap work like generating API tokens. It
 * gets no request context: the response — its session cookie included — is
 * the route's. A throw is logged and the bootstrap still succeeds, since it
 * has already committed. Twin of the Rust `BootstrapKeeperResolved`.
 */
export type OnBootstrap = (created: BootstrapAccountCreated) => Promise<void>;

/**
 * Per-factory configuration for bootstrap route specs.
 *
 * `bootstrap_status` is runtime state (a mutable ref), not a dep or options value —
 * it is passed through so the route handler can flip it.
 */
export interface BootstrapRouteOptions {
	session_options: SessionOptions<string>;
	/** Shared mutable reference — flipped to false when the window closes. */
	bootstrap_status: BootstrapStatus;
	/**
	 * The one-shot token. `null` mounts the route permanently closed
	 * (`'surface_only'`), answering `already_bootstrapped` as a bootstrapped
	 * server does.
	 */
	token_store: BootstrapTokenStore | null;
	/** Called after a successful bootstrap commits. */
	on_bootstrap?: OnBootstrap;
	/**
	 * Rate limiter for bootstrap attempts, keyed by client IP. Pass `null` to
	 * disable. Its own instance, not login's: bootstrap is one-shot and its
	 * bucket is never refunded on success (see `RateLimiter.reset`), so a
	 * fumbled token would otherwise leave the operator's *login* budget nearly
	 * spent on a deployment where their new account is the only one that
	 * exists. The token is 32 bytes of CSPRNG compared in constant time, so
	 * guessing is not what it bounds: the `invalid_token` and
	 * `token_file_undeletable` legs write an unauthenticated audit row each and
	 * leave the window open, and the limiter bounds them. Twin of the Rust
	 * `BootstrapOptions.bootstrap_ip_rate_limiter`.
	 */
	bootstrap_ip_rate_limiter: RateLimiter | null;
}

/**
 * Dependencies for checking bootstrap status at startup.
 */
export interface CheckBootstrapStatusDeps {
	/** Only the single-row `bootstrap_lock` read — narrower than the full `Db`. */
	db: Pick<Db, 'query_one'>;
	log: Logger;
}

/**
 * Check bootstrap availability at startup.
 *
 * Bootstrap is available when a token store is configured, the
 * `bootstrap_lock` row shows `bootstrapped = false`, and the token file
 * passes the same `read_bootstrap_token` the request makes — so "bootstrap
 * is available" and "the token file can actually be read" can't drift apart.
 *
 * The lock is read first, so the report fits the state:
 *
 * - a missing `bootstrap_lock` row is unavailable, logged as an `error` — the
 *   migration seeds it, and without it every bootstrap would be refused in
 *   its transaction while `/status` advertised an open window
 * - bootstrapped, no readable token file: `info`, the steady state
 * - bootstrapped with a readable token file: a `warn` naming it — it would
 *   reopen bootstrap on an empty database, so the operator should delete it
 * - not bootstrapped and the file unreadable: a `warn` with the reason (and
 *   the `error` a short token logs)
 *
 * Twin of the Rust spine's `is_bootstrap_available`, which logs the same
 * states at the same levels. A failed lock read throws here (boot fails)
 * where the Rust twin reads it as unavailable.
 *
 * @param deps - the lock read and a logger
 * @param options - the token store, `null` when bootstrap is not configured
 * @returns the initial `BootstrapStatus`
 */
export const check_bootstrap_status = async (
	deps: CheckBootstrapStatusDeps,
	options: { token_store: BootstrapTokenStore | null }
): Promise<BootstrapStatus> => {
	const { db, log } = deps;
	const { token_store } = options;

	if (!token_store) return { available: false };

	const lock_row = await db.query_one<{ bootstrapped: boolean }>(
		'SELECT bootstrapped FROM bootstrap_lock WHERE id = 1'
	);
	if (!lock_row) {
		log.error(
			'Bootstrap unavailable: the bootstrap_lock row is missing — the auth migration seeds it; restore it to bootstrap'
		);
		return { available: false };
	}

	if (lock_row.bootstrapped) {
		let present = true;
		try {
			await token_store.read_token();
		} catch {
			present = false;
		}
		if (present) {
			log.warn(
				`Bootstrap token file present on a bootstrapped server at ${token_store.path} — it would reopen bootstrap on an empty database; delete it`
			);
		} else {
			log.info('Bootstrap unavailable: already bootstrapped');
		}
		return { available: false };
	}

	try {
		await read_bootstrap_token({ token_store, log });
	} catch (err) {
		log.warn(`Bootstrap unavailable: token file unreadable: ${to_error_message(err)}`);
		return { available: false };
	}

	log.info(`Bootstrap token available: ${token_store.path}`);
	return { available: true };
};

/**
 * Create bootstrap route specs for first-time account creation.
 *
 * @param deps - stateless capabilities (keyring, password, audit, log)
 * @param options - per-factory configuration (session, token store, bootstrap status, limiter)
 * @returns route specs (not yet applied to Hono)
 */
export const create_bootstrap_route_specs = (
	deps: RouteFactoryDeps,
	options: BootstrapRouteOptions
): Array<RouteSpec> => {
	const {
		session_options,
		bootstrap_status,
		token_store,
		on_bootstrap,
		bootstrap_ip_rate_limiter
	} = options;

	return [
		attach_route_handler(bootstrap_route_shape, async (route) => {
			// Short-circuit if bootstrap already completed or surface-only mounted.
			// In 'surface_only' mode `token_store === null`; in 'live' mode after
			// the window closes `available` is `false`. Either way the wire shape
			// is 403 ALREADY_BOOTSTRAPPED, and no audit row is written: the route
			// stays mounted for the life of the process, so an emit here would be
			// an unauthenticated, unbounded write channel.
			if (!bootstrap_status.available || token_store === null) {
				return route_fail(REST_ALREADY_BOOTSTRAPPED);
			}

			// Per-IP rate limit (before any token/DB work). Reserved, not
			// checked: the attempt counts against the cap until it settles, so
			// a concurrent burst of token guesses can't all pass before any of
			// it records. A refusal records it; the race loser, a success, and
			// a throw release it in the `finally`.
			// keyed by the address's rate-limit key (an IPv6 client's /64). With
			// no resolved client IP that is one shared `'unknown'` bucket, where
			// the Rust twin skips the limiter — the difference signup has too, and
			// one only an app mounted without the proxy middleware can show.
			const ip_key = bootstrap_ip_rate_limiter ? rate_limit_ip_key(route.client_ip) : null;
			const ip_reserved = await reserve_optional(bootstrap_ip_rate_limiter, ip_key, {
				signal: route.signal
			});
			if (!ip_reserved.ok) {
				return route_fail(REST_RATE_LIMIT_EXCEEDED, { retry_after: ip_reserved.retry_after });
			}
			try {
				const input = route.input;

				// `transaction: false` makes `route.db` the pool. `bootstrap_account`
				// manages its own transaction internally.
				const result = await bootstrap_account(
					{
						db: route.db,
						token_store,
						password: deps.password,
						keyring: deps.keyring,
						log: deps.log
					},
					input.token,
					input,
					{ session_options }
				);
				if (!result.ok) {
					// The lock-race loser — the window open here, the lock already
					// flipped in the database. Close the window so the next caller
					// takes the short-circuit, and write nothing and charge nothing:
					// it is reachable only by a concurrent legitimate attempt, and
					// folding it into the silent closed-window refusal keeps the
					// post-bootstrap probe channel write-free. Twin of the Rust
					// spine's `bootstrap_handler`.
					if (result.error === ERROR_ALREADY_BOOTSTRAPPED) {
						bootstrap_status.available = false;
						return route_fail(REST_ALREADY_BOOTSTRAPPED);
					}
					// An unreadable token file closes the window. Bootstrap cannot
					// succeed without one, and `check_bootstrap_status` already reads
					// an unreadable file as unavailable at startup — so leaving the
					// flag set means the two disagree, and every later request takes
					// this leg and writes another audit row. A wrong token and an
					// undeletable file leave it open (the operator retries); the
					// limiter bounds those.
					if (result.error === ERROR_TOKEN_FILE_MISSING) bootstrap_status.available = false;
					ip_reserved.reservation.record();
					await deps.audit.emit(route, {
						event_type: 'bootstrap',
						outcome: 'failure',
						ip: route.client_ip,
						metadata: { error: result.error }
					});
					return route_fail(
						result.error === ERROR_TOKEN_FILE_MISSING
							? REST_TOKEN_FILE_MISSING
							: result.error === ERROR_TOKEN_FILE_UNDELETABLE
								? REST_TOKEN_FILE_UNDELETABLE
								: REST_INVALID_TOKEN
					);
				}

				// Successful bootstrap — committed, its token burned. Nothing is
				// reset: bootstrap has no account-grain bucket to forgive (it
				// predates any account), and the IP bucket is never refunded on
				// success (see `RateLimiter.reset`). Bootstrap is one-shot, so at
				// most `max_attempts - 1` residual entries survive — and they sit
				// on this route's own limiter, not login's.
				bootstrap_status.available = false;

				// the session was minted in the transaction; its cookie rides the
				// success
				const set_cookie = session_cookie_header(result.session_cookie_value, session_options);

				const { account, actor, role_grants } = result;
				if (on_bootstrap) {
					try {
						await on_bootstrap({ account, actor, role_grants });
					} catch (err) {
						deps.log.error(`on_bootstrap callback failed: ${to_error_message(err)}`);
					}
				}

				await deps.audit.emit(route, {
					event_type: 'bootstrap',
					actor_id: actor.id,
					account_id: account.id,
					ip: route.client_ip
				});

				return route_ok(
					{
						ok: true,
						account: { id: account.id, username: account.username },
						actor: { id: actor.id }
					},
					{ set_cookie: [set_cookie] }
				);
			} finally {
				ip_reserved.reservation.release();
			}
		})
	];
};
