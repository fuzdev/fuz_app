/**
 * Bootstrap flow for creating the first account.
 *
 * Uses an atomic `bootstrap_lock` table to prevent TOCTOU race conditions.
 * The lock flip, the account, its keeper and admin grants, its session, and
 * the burn of the one-shot token file all happen in one transaction, the burn
 * last — so a live token never outlives a successful bootstrap, and a
 * bootstrap whose token can't be burned never happened.
 *
 * @module
 */

import { timingSafeEqual } from 'node:crypto';
import type { Logger } from '@fuzdev/fuz_util/log.ts';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';

import type { PasswordHashDeps } from './password.ts';
import {
	ERROR_INVALID_TOKEN,
	ERROR_ALREADY_BOOTSTRAPPED,
	ERROR_TOKEN_FILE_MISSING,
	ERROR_TOKEN_FILE_UNDELETABLE
} from '../http/error_schemas.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from './role_schema.ts';
import type { Account, Actor, RoleGrant } from './account_schema.ts';
import { query_create_account_with_actor } from './account_queries.ts';
import { query_create_role_grant } from './role_grant_queries.ts';
import {
	transaction_with_post_commit_rollback,
	type RequestEffectsContext
} from '../http/pending_effects.ts';
import type { AuditEmitter } from './audit_emitter.ts';
import type { BootstrapTokenStore } from './bootstrap_token_store.ts';
import type { Keyring } from './keyring.ts';
import { session_cookie_header, type SessionOptions } from './session_cookie.ts';
import { create_capped_session } from './session_queries.ts';
import { DEFAULT_MAX_SESSIONS } from './account_route_schema.ts';

/** Input for the bootstrap account creation. */
export interface BootstrapAccountInput {
	username: string;
	password: string;
}

/** What a successful bootstrap created. */
export interface BootstrapAccountCreated {
	account: Account;
	actor: Actor;
	role_grants: { keeper: RoleGrant; admin: RoleGrant };
}

/** Successful bootstrap result with the created entities and the new session. */
export interface BootstrapAccountSuccess extends BootstrapAccountCreated {
	ok: true;
	/**
	 * The `Set-Cookie` line of the session minted in the bootstrap
	 * transaction, formatted inside it, for the caller to set on its
	 * response — it exists only because the transaction committed.
	 */
	set_cookie: string;
}

/** Bootstrap failure result. */
export type BootstrapAccountFailure =
	| { ok: false; error: typeof ERROR_ALREADY_BOOTSTRAPPED; status: 403 }
	| { ok: false; error: typeof ERROR_TOKEN_FILE_MISSING; status: 404 }
	| { ok: false; error: typeof ERROR_INVALID_TOKEN; status: 401 }
	| { ok: false; error: typeof ERROR_TOKEN_FILE_UNDELETABLE; status: 500 };

/** Bootstrap account result — either success or a bootstrap verification failure. */
export type BootstrapAccountResult = BootstrapAccountSuccess | BootstrapAccountFailure;

/**
 * Dependencies for `bootstrap_account`.
 */
export interface BootstrapAccountDeps {
	/** Writes the `bootstrap` success row in the bootstrap transaction. */
	audit: Pick<AuditEmitter, 'emit'>;
	/**
	 * The one-shot token: read through the hardened secret read (a symlinked,
	 * non-regular, group/other-readable, multiply-linked, or oversized file is
	 * refused — every refusal reads as `TOKEN_FILE_MISSING`), burned last inside the
	 * transaction.
	 */
	token_store: BootstrapTokenStore;
	/** Only hashing is needed — verification happens separately during login. */
	password: Pick<PasswordHashDeps, 'hash_password'>;
	/** Signs the session cookie minted in the transaction. */
	keyring: Keyring;
	/** Structured logger instance. */
	log: Logger;
}

/**
 * The request `bootstrap_account` runs for: its pool-level `db` (the bootstrap
 * opens its own transaction), its side-effect queues (the success row's
 * listener fan-out is queued post-commit), and the client IP its audit row
 * records. A `RouteContext` satisfies it.
 */
export interface BootstrapAccountContext extends RequestEffectsContext {
	/** Resolved client IP from the trusted-proxy middleware — `'unknown'` if not resolved. */
	client_ip: string;
}

/** Static options for `bootstrap_account`. */
export interface BootstrapAccountOptions {
	/** Session cookie configuration for the session the bootstrap mints. */
	session_options: SessionOptions<string>;
}

/**
 * Thrown out of the bootstrap transaction when the token can't be burned, so
 * the transaction rolls back — `db.transaction` commits when its callback
 * returns. Caught around the transaction and mapped to
 * `ERROR_TOKEN_FILE_UNDELETABLE`; never escapes `bootstrap_account`.
 */
class BootstrapTokenBurnError extends Error {}

/**
 * Strip exactly one trailing `\n` from the operator-written token bytes.
 *
 * Not `trim()`: trimming widens the set of accepted tokens — `tok\r\n`,
 * `tok  \n`, or a leading newline would all pass. One trailing LF is the
 * newline a POSIX editor appends; anything else stays in the bytes and fails
 * the compare, so operators write the token exactly. Twin of the Rust
 * `strip_one_trailing_newline` (`fuz_auth`).
 */
const strip_one_trailing_newline = (bytes: Uint8Array): Uint8Array =>
	bytes.at(-1) === 0x0a ? bytes.subarray(0, -1) : bytes;

/**
 * The fewest bytes a bootstrap token holds, counted after its one optional
 * trailing LF. A shorter file is read as unreadable: an empty or `"\n"` file
 * would otherwise leave bootstrap advertised as open while nothing can ever
 * match it, and a short token is guessable. Every generator writes more
 * (32 random bytes as 64 lowercase hex characters); the readers accept any
 * bytes that clear this floor. Twin of the Rust `BOOTSTRAP_TOKEN_MIN_BYTES`
 * (`fuz_auth`).
 */
export const BOOTSTRAP_TOKEN_MIN_BYTES = 32;

/**
 * Read the bootstrap token the way both the availability check and the
 * request-time compare need it: the store's hardened read, less one trailing
 * LF, refused when shorter than `BOOTSTRAP_TOKEN_MIN_BYTES`. A short token
 * logs an error naming the file before the throw — it is a misconfiguration
 * the operator must fix, never a quiet "unavailable". Twin of the Rust
 * `bootstrap_token_from_file`.
 *
 * @param deps - the token store and a logger for the short-token error
 * @returns the token bytes the provided token is compared against
 * @throws Error when the store refuses the file or the token is too short
 */
export const read_bootstrap_token = async (
	deps: Pick<BootstrapAccountDeps, 'token_store' | 'log'>
): Promise<Uint8Array> => {
	const { token_store } = deps;
	const token = strip_one_trailing_newline(await token_store.read_token());
	if (token.length < BOOTSTRAP_TOKEN_MIN_BYTES) {
		const message = `bootstrap token at ${token_store.path} is ${token.length} bytes, under the ${BOOTSTRAP_TOKEN_MIN_BYTES}-byte minimum — regenerate it`;
		deps.log.error(message);
		throw new Error(message);
	}
	return token;
};

/**
 * Bootstrap the first account with keeper and admin privileges.
 *
 * 1. Read and verify the bootstrap token (before the transaction) — the
 *    file's raw bytes less one optional trailing LF, at least
 *    `BOOTSTRAP_TOKEN_MIN_BYTES` long, compared in constant time
 * 2. Hash the password (CPU-intensive, before the transaction)
 * 3. In one transaction: flip the `bootstrap_lock` atomically (zero rows is
 *    the race loser, `already_bootstrapped`, nothing burned); create the
 *    account + actor; grant keeper and admin (no expiry, `granted_by =
 *    null`); mint the session through the capped minter login uses (the cap
 *    evicts nothing on a new account) and format its `Set-Cookie` line; write
 *    the `bootstrap` success audit row; then burn the token file, last, just
 *    before the commit
 *
 * The burn comes after the lock, so only the lock winner burns (its row lock
 * is held across the unlink, so a concurrent attempt waits on its UPDATE);
 * after the inserts, so a failed insert spends nothing; last, so the window
 * between a burn and a failed commit is one round trip. The audit row is
 * written before the burn, so a refused row rolls the bootstrap back with the
 * token unburned and the window open, as a failed insert does; its listener
 * fan-out is discarded with any rollback. A burn that fails
 * rolls everything back and answers `token_file_undeletable`: nothing was
 * created and the token is still valid, so the operator fixes the directory
 * and retries. A commit that fails after the burn is logged as an error — the
 * token is gone and a new one must be written. Twin of the Rust
 * `bootstrap_handler`.
 *
 * @param deps - token store, password hashing, keyring, audit emitter, and logger
 * @param ctx - the request's pool `db`, side-effect queues, and client IP
 * @param provided_token - the bootstrap token from the user
 * @param input - username and password
 * @param options - the session cookie configuration
 * @returns the created account, actor, role_grants, and the session's `Set-Cookie` line — or a bootstrap failure
 * @mutates `bootstrap_lock` row - flips `bootstrapped` to `true` atomically
 * @mutates `account` / `actor` / `role_grant` / `auth_session` / `audit_log` tables - inserts the bootstrap account, actor, keeper + admin role_grants, session, and success row
 * @mutates `ctx.post_commit_effects` - appends the success row's listener fan-out, discarded on rollback
 * @mutates filesystem - burns the bootstrap token file inside the transaction
 */
export const bootstrap_account = async (
	deps: BootstrapAccountDeps,
	ctx: BootstrapAccountContext,
	provided_token: string,
	input: BootstrapAccountInput,
	options: BootstrapAccountOptions
): Promise<BootstrapAccountResult> => {
	const { token_store, password, keyring, audit, log } = deps;

	// 1. Read and verify token (non-destructive, before transaction). The
	// secure read fails loud on a symlink / non-regular file / permissive mode /
	// second hard link / oversized file, and the read refuses a token under the minimum length —
	// every refusal masks as the same TOKEN_FILE_MISSING the wire always
	// carried, with the specific reason logged for the operator.
	let expected_token: Uint8Array;
	try {
		expected_token = await read_bootstrap_token({ token_store, log });
	} catch (err) {
		log.warn(`bootstrap token file rejected: ${to_error_message(err)}`);
		return { ok: false, error: ERROR_TOKEN_FILE_MISSING, status: 404 };
	}
	// raw bytes on both sides, nothing trimmed — the provided token must be the
	// file's bytes exactly, less the one newline an editor appends
	const provided_buf = Buffer.from(provided_token);
	if (
		provided_buf.length !== expected_token.length ||
		!timingSafeEqual(provided_buf, expected_token)
	) {
		return { ok: false, error: ERROR_INVALID_TOKEN, status: 401 };
	}

	// 2. Hash password (CPU-intensive, before transaction)
	const password_hash = await password.hash_password(input.password);

	// 3. Atomic transaction: lock, create, mint, burn
	let burned = false;
	let tx_result;
	try {
		tx_result = await transaction_with_post_commit_rollback(ctx, async (tx_ctx) => {
			const lock_rows = await tx_ctx.db.query<{ id: number }>(
				'UPDATE bootstrap_lock SET bootstrapped = true WHERE id = 1 AND bootstrapped = false RETURNING id'
			);
			if (lock_rows.length === 0) {
				return { ok: false as const, error: ERROR_ALREADY_BOOTSTRAPPED, status: 403 as const };
			}

			const { account, actor } = await query_create_account_with_actor(tx_ctx, {
				username: input.username,
				password_hash
			});

			const keeper_role_grant = await query_create_role_grant(tx_ctx, {
				actor_id: actor.id,
				role: ROLE_KEEPER,
				granted_by: null,
				expires_at: null
			});
			const admin_role_grant = await query_create_role_grant(tx_ctx, {
				actor_id: actor.id,
				role: ROLE_ADMIN,
				granted_by: null,
				expires_at: null
			});

			// The account was created above, so the cap evicts nothing. Routed
			// through the shared minter anyway: the cap is a property of session
			// creation, not of the login route.
			const { cookie_value } = await create_capped_session({
				keyring,
				deps: tx_ctx,
				account_id: account.id,
				session_options: options.session_options,
				max_sessions: DEFAULT_MAX_SESSIONS
			});
			// formatted here, as login and signup format theirs: a value the
			// formatter refuses rolls the bootstrap back with the token unburned
			const set_cookie = session_cookie_header(cookie_value, options.session_options);

			// The success row, in the transaction and ahead of the burn: a refused
			// INSERT rolls the bootstrap back with the token unburned and the
			// window open, as a failed insert above does.
			await audit.emit(tx_ctx, {
				event_type: 'bootstrap',
				actor_id: actor.id,
				account_id: account.id,
				ip: ctx.client_ip
			});

			// the burn, last before the commit
			let outcome;
			try {
				outcome = await token_store.burn_token();
			} catch (err) {
				throw new BootstrapTokenBurnError(to_error_message(err), { cause: err });
			}
			burned = true;
			if (outcome === 'already_gone') {
				log.warn('bootstrap token file was already gone at the burn — counted as burned');
			}

			return {
				ok: true as const,
				account,
				actor,
				role_grants: { keeper: keeper_role_grant, admin: admin_role_grant },
				set_cookie
			};
		});
	} catch (err) {
		if (err instanceof BootstrapTokenBurnError) {
			log.error(
				`bootstrap rolled back: could not delete the token file at ${token_store.path} (${err.message}) — the server user needs write access to its directory; nothing was created and the token is still valid, retry`
			);
			return { ok: false, error: ERROR_TOKEN_FILE_UNDELETABLE, status: 500 };
		}
		if (burned) {
			log.error(
				`bootstrap rolled back after its token file at ${token_store.path} was deleted (${to_error_message(err)}) — write a new token and restart the server to bootstrap`
			);
		}
		throw err;
	}

	return tx_result;
};
