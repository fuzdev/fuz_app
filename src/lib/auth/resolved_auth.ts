/**
 * The account-grain credential a request resolved to, and the re-check a
 * long-lived connection runs on it once it is registered.
 *
 * The auth middleware chain (daemon token → session cookie → bearer) resolves a
 * credential and leaves it on the Hono context as separate keys.
 * `ResolvedAuth` is that credential gathered into one value
 * (`get_resolved_auth`), so the connections that outlive their request — a
 * WebSocket, an SSE stream — can carry it past the handshake and re-read it
 * with `revalidate_resolved_auth`.
 *
 * @module
 */

import type { Context } from 'hono';

import type { QueryDeps } from '../db/query_deps.ts';
import {
	ACCOUNT_ID_KEY,
	AUTH_API_TOKEN_ID_KEY,
	CREDENTIAL_TYPE_KEY,
	type CredentialType
} from '../hono_context.ts';
import { query_account_by_id } from './account_queries.ts';
import { query_api_token_live_account } from './api_token_queries.ts';
import { AUTH_SESSION_TOKEN_HASH_KEY } from './request_context.ts';
import { query_session_get_valid } from './session_queries.ts';

/**
 * An authenticated request's credential, account-grain — no actor.
 *
 * `token_hash` is set for a session, `api_token_id` for an API token, and both
 * are `null` for a daemon token. The twin of the Rust spine's `ResolvedAuth`,
 * which carries the account row and token scope as well; here those stay on
 * the Hono context.
 */
export interface ResolvedAuth {
	/** The authenticated account. */
	account_id: string;
	/** How the request was authenticated. */
	credential_type: CredentialType;
	/** Blake3 hash of the session token, or `null` for non-session credentials. */
	token_hash: string | null;
	/** `api_token.id` for a bearer credential, else `null`. */
	api_token_id: string | null;
}

/**
 * Gather the credential the auth middleware resolved for this request.
 *
 * Reads the keys the session, bearer, and daemon-token middleware set and
 * keeps only the one that belongs to the winning credential type — a daemon
 * token overrides a session cookie sent alongside it without clearing that
 * session's hash, so the hash is carried for a session credential alone.
 *
 * @param c - the request context, after the auth middleware chain
 * @returns the resolved credential, or `null` for an unauthenticated request
 */
export const get_resolved_auth = (c: Context): ResolvedAuth | null => {
	const account_id = c.get(ACCOUNT_ID_KEY) ?? null;
	const credential_type = c.get(CREDENTIAL_TYPE_KEY) ?? null;
	if (account_id === null || credential_type === null) return null;
	return {
		account_id,
		credential_type,
		token_hash: credential_type === 'session' ? (c.get(AUTH_SESSION_TOKEN_HASH_KEY) ?? null) : null,
		api_token_id: credential_type === 'api_token' ? (c.get(AUTH_API_TOKEN_ID_KEY) ?? null) : null
	};
};

/**
 * Re-check that a resolved credential still authenticates: `true` when it
 * does, `false` when it has been revoked, has expired, or its account is gone.
 *
 * For a connection that outlives its request — a WebSocket, an SSE stream —
 * and is authorized once, at open. Such a connection is closed on revocation
 * by identity, but only once it is *registered*; between the credential read
 * and the registration a revocation closes nothing. So the opener registers
 * first (un-admitted — `BackendWebsocketTransport.register_pending` /
 * `SubscriberRegistry.subscribe_pending`), then calls this, then admits. A
 * revocation that committed before this read is seen by it; one whose close
 * ran after the registration found the pending entry.
 *
 * That needs each statement here to see everything committed before it
 * started, so `deps.db` must be the pool-level `Db` (autocommit) or a
 * `READ COMMITTED` transaction — never a `REPEATABLE READ` / `SERIALIZABLE`
 * transaction opened before the registration, whose snapshot would predate
 * it.
 *
 * What is re-read, per credential — each through the same predicate the
 * resolve path used, so the two cannot disagree about what "valid" means (the
 * session and account legs call the middleware's own queries; the token leg
 * shares its `WHERE` fragment):
 *
 * - **Session** — the `auth_session` row still exists, is unexpired, and
 *   belongs to the resolved account.
 * - **API token** — the `api_token` row still exists, is unexpired, and
 *   belongs to the resolved account (by id; the raw token is not kept).
 * - **Daemon token** — nothing of its own. The token has no row, and no
 *   revocation event: rotation closes no connection, so there is no close an
 *   opening connection could have missed. Its keeper account is still
 *   re-read.
 * - **Every credential** — the account row still exists and is not
 *   soft-deleted.
 *
 * It re-checks the **credential**, not what a revocation chose to close: a
 * `logout` closes every connection of the account but deletes only its own
 * session, so another session's connection opening concurrently passes this
 * check and is refused only if that account-wide close found its pending
 * registration — the same two outcomes an already-open connection has.
 *
 * **No side effects.** Unlike the bearer middleware this never touches
 * `api_token.last_used_at` / `last_used_ip` — re-checking a credential is not
 * using it — and it writes nothing else.
 *
 * A `ResolvedAuth` whose credential type lacks its own key (a session with no
 * `token_hash`, a bearer with no `api_token_id`) is a shape the middleware
 * never builds; it is answered `false`.
 *
 * The twin of the Rust spine's `revalidate_resolved_auth`.
 *
 * @param deps - query dependencies; the pool-level `Db`, not a snapshot transaction
 * @param resolved - the credential the request authenticated with
 * @returns whether the credential still authenticates
 * @throws Error propagated from the database. The caller must fail closed — an
 *   unchecked credential is not a valid one.
 */
export const revalidate_resolved_auth = async (
	deps: QueryDeps,
	resolved: ResolvedAuth
): Promise<boolean> => {
	const { account_id } = resolved;
	let credential_is_live: boolean;
	switch (resolved.credential_type) {
		case 'session': {
			if (resolved.token_hash === null) return false;
			const session = await query_session_get_valid(deps, resolved.token_hash);
			credential_is_live = session?.account_id === account_id;
			break;
		}
		case 'api_token': {
			if (resolved.api_token_id === null) return false;
			const owner = await query_api_token_live_account(deps, resolved.api_token_id);
			credential_is_live = owner === account_id;
			break;
		}
		case 'daemon_token':
			credential_is_live = true;
			break;
	}
	if (!credential_is_live) return false;
	return (await query_account_by_id(deps, account_id)) !== undefined;
};
