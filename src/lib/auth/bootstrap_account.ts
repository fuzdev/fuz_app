/**
 * Bootstrap flow for creating the first account.
 *
 * Uses an atomic `bootstrap_lock` table to prevent TOCTOU race conditions.
 * Token verification and account creation happen in a single transaction.
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
	ERROR_TOKEN_FILE_MISSING
} from '../http/error_schemas.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from './role_schema.ts';
import type { Account, Actor, RoleGrant } from './account_schema.ts';
import { query_create_account_with_actor } from './account_queries.ts';
import { query_create_role_grant } from './role_grant_queries.ts';
import type { Db } from '../db/db.ts';

/** Input for the bootstrap account creation. */
export interface BootstrapAccountInput {
	username: string;
	password: string;
}

/** Successful bootstrap result with the created entities. */
export interface BootstrapAccountSuccess {
	ok: true;
	account: Account;
	actor: Actor;
	role_grants: { keeper: RoleGrant; admin: RoleGrant };
	/** Whether the bootstrap token file was successfully deleted after account creation. */
	token_file_deleted: boolean;
}

/** Bootstrap failure result. */
export type BootstrapAccountFailure =
	| { ok: false; error: typeof ERROR_ALREADY_BOOTSTRAPPED; status: 403 }
	| { ok: false; error: typeof ERROR_TOKEN_FILE_MISSING; status: 404 }
	| { ok: false; error: typeof ERROR_INVALID_TOKEN; status: 401 };

/** Bootstrap account result — either success or a bootstrap verification failure. */
export type BootstrapAccountResult = BootstrapAccountSuccess | BootstrapAccountFailure;

/**
 * Dependencies for `bootstrap_account`.
 */
export interface BootstrapAccountDeps {
	db: Db;
	/** Path to the bootstrap token file on disk. */
	token_path: string;
	/**
	 * Hardened secret-file read (see `FsSecureReadDeps.read_secure_file`) —
	 * the token mints the keeper account, so a symlinked, non-regular,
	 * group/other-readable, or oversized file must refuse rather than be
	 * honored. Throws on refusal;
	 * every throw reads as `TOKEN_FILE_MISSING` upstream.
	 */
	read_secure_file: (path: string) => Promise<Uint8Array>;
	/** Delete a file. */
	delete_file: (path: string) => Promise<void>;
	/** Only hashing is needed — verification happens separately during login. */
	password: Pick<PasswordHashDeps, 'hash_password'>;
	/** Structured logger instance. */
	log: Logger;
}

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
 * match it, and a short token is guessable. Every generator writes at least
 * this much (32 random bytes, base64url or hex encoded). Twin of the Rust
 * `BOOTSTRAP_TOKEN_MIN_BYTES` (`fuz_auth`).
 */
export const BOOTSTRAP_TOKEN_MIN_BYTES = 32;

/**
 * Read the bootstrap token the way both the availability check and the
 * request-time compare need it: the hardened secure read, less one trailing
 * LF, refused when shorter than `BOOTSTRAP_TOKEN_MIN_BYTES`. A short token
 * logs an error naming the file before the throw — it is a misconfiguration
 * the operator must fix, never a quiet "unavailable". Twin of the Rust
 * `bootstrap_token_from_file`.
 *
 * @param deps - the secure read and a logger for the short-token error
 * @param token_path - the bootstrap token file
 * @returns the token bytes the provided token is compared against
 * @throws Error when the secure read refuses the file or the token is too short
 */
export const read_bootstrap_token = async (
	deps: Pick<BootstrapAccountDeps, 'read_secure_file' | 'log'>,
	token_path: string
): Promise<Uint8Array> => {
	const token = strip_one_trailing_newline(await deps.read_secure_file(token_path));
	if (token.length < BOOTSTRAP_TOKEN_MIN_BYTES) {
		const message = `bootstrap token at ${token_path} is ${token.length} bytes, under the ${BOOTSTRAP_TOKEN_MIN_BYTES}-byte minimum — regenerate it`;
		deps.log.error(message);
		throw new Error(message);
	}
	return token;
};

/**
 * Bootstrap the first account with keeper and admin privileges.
 *
 * Uses an atomic `bootstrap_lock` UPDATE to prevent concurrent bootstrap
 * attempts (TOCTOU). The full flow runs in a single transaction:
 *
 * 1. Read and verify the bootstrap token (before transaction) — the file's
 *    raw bytes less one optional trailing LF, at least
 *    `BOOTSTRAP_TOKEN_MIN_BYTES` long, compared in constant time
 * 2. Hash the password (CPU-intensive, before transaction)
 * 3. Acquire the bootstrap lock atomically (inside transaction)
 * 4. Create account + actor
 * 5. Grant keeper and admin role_grants (no expiry, `granted_by = null`)
 * 6. Delete the token file (after commit, reported via `token_file_deleted`)
 *
 * @param deps - database, token path, filesystem callbacks, and password hashing
 * @param provided_token - the bootstrap token from the user
 * @param input - username and password
 * @returns the created account, actor, and role_grants — or a bootstrap failure
 * @mutates `bootstrap_lock` row - flips `bootstrapped` to `true` atomically
 * @mutates `account` / `actor` / `role_grant` tables - inserts the bootstrap account, actor, and the keeper + admin role_grants
 * @mutates filesystem - deletes the bootstrap token file after commit (reported via `token_file_deleted`)
 */
export const bootstrap_account = async (
	deps: BootstrapAccountDeps,
	provided_token: string,
	input: BootstrapAccountInput
): Promise<BootstrapAccountResult> => {
	const { db, token_path, read_secure_file, delete_file, password, log } = deps;

	// 1. Read and verify token (non-destructive, before transaction). The
	// secure read fails loud on a symlink / non-regular file / permissive mode /
	// oversized file, and the read refuses a token under the minimum length —
	// every refusal masks as the same TOKEN_FILE_MISSING the wire always
	// carried, with the specific reason logged for the operator.
	let expected_token: Uint8Array;
	try {
		expected_token = await read_bootstrap_token({ read_secure_file, log }, token_path);
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

	// 3. Atomic transaction: lock + create
	const tx_result = await db.transaction(async (tx) => {
		const lock_rows = await tx.query<{ id: number }>(
			'UPDATE bootstrap_lock SET bootstrapped = true WHERE id = 1 AND bootstrapped = false RETURNING id'
		);
		if (lock_rows.length === 0) {
			return { ok: false as const, error: ERROR_ALREADY_BOOTSTRAPPED, status: 403 as const };
		}

		const tx_deps = { db: tx };
		const { account, actor } = await query_create_account_with_actor(tx_deps, {
			username: input.username,
			password_hash
		});

		const keeper_role_grant = await query_create_role_grant(tx_deps, {
			actor_id: actor.id,
			role: ROLE_KEEPER,
			granted_by: null,
			expires_at: null
		});
		const admin_role_grant = await query_create_role_grant(tx_deps, {
			actor_id: actor.id,
			role: ROLE_ADMIN,
			granted_by: null,
			expires_at: null
		});

		return {
			ok: true as const,
			account,
			actor,
			role_grants: { keeper: keeper_role_grant, admin: admin_role_grant }
		};
	});

	if (!tx_result.ok) return tx_result;

	// 4. Delete token file (after commit)
	let token_file_deleted = true;
	try {
		await delete_file(token_path);
	} catch {
		token_file_deleted = false;
		log.error(
			`CRITICAL: Failed to delete bootstrap token file at ${token_path}. Delete it manually.`
		);
	}

	return { ...tx_result, token_file_deleted };
};
