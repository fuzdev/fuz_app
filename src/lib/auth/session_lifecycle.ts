/**
 * Session lifecycle — creation and cookie management shared across login and bootstrap flows.
 *
 * @module
 */

import type {Context} from 'hono';

import type {Keyring} from './keyring.js';
import {create_session_cookie_value, type SessionOptions} from './session_cookie.js';
import {set_session_cookie} from './session_middleware.js';
import {
	generate_session_token,
	hash_session_token,
	AUTH_SESSION_LIFETIME_MS,
	query_create_session,
	query_session_enforce_limit,
} from './session_queries.js';
import type {QueryDeps} from '../db/query_deps.js';

/**
 * Options for `create_session_and_set_cookie`.
 */
export interface CreateSessionAndSetCookieOptions {
	/** Keyring for cookie signing. */
	keyring: Keyring;
	/** Query deps (needs db for session creation). */
	deps: QueryDeps;
	/** Hono context for setting the cookie. */
	c: Context;
	/** The account to create a session for. */
	account_id: string;
	/** Session cookie configuration. */
	session_options: SessionOptions<string>;
	/** Per-account session cap (`null` to skip enforcement). */
	max_sessions?: number | null;
}

/**
 * Create an auth session and set the session cookie on the response.
 *
 * Shared by login and bootstrap — generates a token, hashes it, persists
 * the session row, optionally enforces a per-account session limit, and
 * sets the signed cookie.
 */
export const create_session_and_set_cookie = async (
	options: CreateSessionAndSetCookieOptions,
): Promise<void> => {
	const {keyring, deps, c, account_id, session_options, max_sessions} = options;
	const session_token = generate_session_token();
	const token_hash = hash_session_token(session_token);
	const expires_at = new Date(Date.now() + AUTH_SESSION_LIFETIME_MS);
	await query_create_session(deps, token_hash, account_id, expires_at);

	if (max_sessions != null) {
		await query_session_enforce_limit(deps, account_id, max_sessions);
	}

	const cookie_value = await create_session_cookie_value(keyring, session_token, session_options);
	set_session_cookie(c, cookie_value, session_options);
};
