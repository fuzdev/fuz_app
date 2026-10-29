/**
 * The account-grain credential a request resolved to, and the re-check a
 * long-lived connection runs on it once it is registered.
 *
 * The auth middleware chain resolves at most one credential per request —
 * daemon token, then session cookie, then bearer, the first that
 * authenticates winning — and leaves it on the Hono context as one value,
 * `ResolvedAuth` (`RESOLVED_AUTH_KEY`, read with `get_resolved_auth`). Every
 * reader takes that value, so the connections that outlive their request — a
 * WebSocket, an SSE stream — carry it past the handshake, re-read it with
 * `revalidate_resolved_auth` (or the whole admission re-check,
 * `recheck_admission`), and close at its `credential_deadline`.
 *
 * @module
 */

import type { Context } from 'hono';

import type { QueryDeps } from '../db/query_deps.ts';
import { RESOLVED_AUTH_KEY } from '../hono_context.ts';
import { query_account_by_id, query_active_actors_by_account } from './account_queries.ts';
import { query_api_token_live_account } from './api_token_queries.ts';
import {
	has_any_scoped_role,
	refresh_role_grants,
	type RequestContext
} from './request_context.ts';
import { query_session_get_valid } from './session_queries.ts';
import { token_scope_full, type TokenScope } from './token_scope.ts';

/** The fields every resolved credential carries. */
interface ResolvedAuthBase {
	/**
	 * The authenticated account. Its id, not its row — the twin of the Rust
	 * spine's `ResolvedAuth::account`, which loads the row as it resolves. Here
	 * the middleware stays one query per credential and the authorization phase
	 * loads the account when a route needs it.
	 */
	readonly account_id: string;
	/**
	 * When the credential stops authenticating, as a monotonic
	 * `performance.now()` timestamp — the moment a long-lived connection opened
	 * on it is closed (`schedule_credential_deadline`), since expiry writes
	 * nothing a revocation listener could hear. The earliest of what the
	 * credential carries: a session's cookie and row expiry, an API token's row
	 * expiry (`null` for an eternal one); `null` for the daemon token. A row's
	 * expiry is read as time remaining on the database clock
	 * (`auth/credential_deadline.ts`). The Rust twin's `credential_deadline`.
	 */
	readonly credential_deadline: number | null;
}

/** A session cookie — full account authority by construction. */
export interface ResolvedSessionAuth extends ResolvedAuthBase {
	readonly credential_type: 'session';
	/** Blake3 hash of the session token — the `auth_session.id`. */
	readonly session_hash: string;
}

/** An `Authorization: Bearer` API token — the only credential a scope narrows. */
export interface ResolvedApiTokenAuth extends ResolvedAuthBase {
	readonly credential_type: 'api_token';
	/** The `api_token.id`. */
	readonly api_token_id: string;
	/** The authority the token was minted with, read off its row. */
	readonly scope: TokenScope;
}

/** The keeper-bound daemon token — full authority, no row, no expiry. */
export interface ResolvedDaemonTokenAuth extends ResolvedAuthBase {
	readonly credential_type: 'daemon_token';
	readonly credential_deadline: null;
}

/**
 * An authenticated request's credential, account-grain — no actor.
 *
 * One arm per credential type, each carrying only what belongs to it: the
 * session hash on a session, the token id and scope on an API token, so a
 * session with a narrowed scope or a bearer with a session hash cannot be
 * built. The twin of the Rust spine's `ResolvedAuth`, whose
 * `ResolvedCredential` enum holds the same correlation.
 */
export type ResolvedAuth = ResolvedSessionAuth | ResolvedApiTokenAuth | ResolvedDaemonTokenAuth;

/**
 * The credential's authority narrowing: an API token's own scope, `full` for a
 * session or the daemon token (a browser session *is* full account authority —
 * narrowing it is what role grants are for — and the daemon token is singular,
 * filesystem-proved, and keeper-bound). `null` only for the anonymous caller,
 * who holds no credential to narrow. Every token-scope gate reads this. The twin
 * of the Rust spine's `ResolvedAuth::scope`.
 *
 * @param auth - the resolved credential, or `null` for an anonymous caller
 * @returns the scope, or `null` for an anonymous caller
 */
export const resolved_auth_scope = (auth: ResolvedAuth | null): TokenScope | null => {
	if (auth === null) return null;
	return auth.credential_type === 'api_token' ? auth.scope : token_scope_full();
};

/**
 * The session hash of a session credential, `null` for any other (or none).
 *
 * @param auth - the resolved credential, or `null` for an anonymous caller
 * @returns the `auth_session.id`, or `null`
 */
export const resolved_auth_session_hash = (auth: ResolvedAuth | null): string | null =>
	auth?.credential_type === 'session' ? auth.session_hash : null;

/**
 * The token id of an API token credential, `null` for any other (or none).
 *
 * @param auth - the resolved credential, or `null` for an anonymous caller
 * @returns the `api_token.id`, or `null`
 */
export const resolved_auth_api_token_id = (auth: ResolvedAuth | null): string | null =>
	auth?.credential_type === 'api_token' ? auth.api_token_id : null;

/**
 * The credential the auth middleware resolved for this request.
 *
 * @param c - the request context, after the auth middleware chain
 * @returns the resolved credential, or `null` for an unauthenticated request
 */
export const get_resolved_auth = (c: Context): ResolvedAuth | null =>
	c.get(RESOLVED_AUTH_KEY) ?? null;

/**
 * Re-check that a resolved credential still authenticates: `true` when it
 * does, `false` when it has been revoked, has expired, or its account is gone.
 *
 * For a connection that outlives its request — a WebSocket, an SSE stream —
 * and is authorized once, at open. Such a connection is closed on revocation
 * by identity, but only once it is *registered*; between the credential read
 * and the registration a revocation closes nothing. So the opener registers
 * first (un-admitted — `ConnectionRegistry.register_pending` /
 * `SseRegistry.subscribe_pending`), then calls this, then admits. A
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
			const session = await query_session_get_valid(deps, resolved.session_hash);
			credential_is_live = session?.account_id === account_id;
			break;
		}
		case 'api_token': {
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

/**
 * What `recheck_admission` found: `'admitted'`, or the first check that
 * refused — the credential, the acting actor, or the endpoint's role.
 */
export type AdmissionRecheck =
	'admitted' | 'credential_revoked' | 'actor_inactive' | 'role_revoked';

/** The connection being admitted, for `recheck_admission`. */
export interface RecheckAdmissionInput {
	/** The credential the request authenticated with (`get_resolved_auth`). */
	resolved: ResolvedAuth;
	/** The request context the upgrade's gates ran against — its acting actor is re-read. */
	request_context: RequestContext;
	/**
	 * The roles the connection's gate required, any-of; `[]` for an ungated
	 * connection. A global grant of any of them admits, as the gate did.
	 */
	required_roles: ReadonlyArray<string>;
}

/**
 * Re-read everything a long-lived connection's gates read, once the
 * connection is registered pending — the admission step a WebSocket upgrade
 * and the audit stream share (twin of the Rust spine's admission re-check).
 *
 * In order, stopping at the first refusal:
 *
 * 1. **The credential** (`revalidate_resolved_auth`) → `'credential_revoked'`.
 * 2. **The acting actor** the gates resolved, when there is one: it must still
 *    be an active actor of the account → `'actor_inactive'`. A soft-deleted
 *    actor keeps its account's credentials and its own grant rows, so neither
 *    other re-read would refuse it.
 * 3. **The role**, when `required_roles` is non-empty: the acting actor's
 *    grants read afresh (`refresh_role_grants`), a **global** grant of any
 *    listed role admitting → `'role_revoked'`. A scoped grant never admits at
 *    a role gate.
 *
 * Every read must see what committed before it started, so `deps.db` is the
 * pool-level `Db` (see `revalidate_resolved_auth`).
 *
 * @param deps - query dependencies; the pool-level `Db`
 * @param input - the credential, the gates' request context, and the required roles
 * @returns `'admitted'`, or which check refused
 * @throws Error propagated from the database. The caller must fail closed — an
 *   unchecked connection is not an admitted one.
 */
export const recheck_admission = async (
	deps: QueryDeps,
	input: RecheckAdmissionInput
): Promise<AdmissionRecheck> => {
	const { resolved, request_context, required_roles } = input;
	if (!(await revalidate_resolved_auth(deps, resolved))) return 'credential_revoked';
	const acting_actor = request_context.actor;
	if (acting_actor) {
		const active = await query_active_actors_by_account(deps, resolved.account_id);
		if (!active.some((a) => a.id === acting_actor.id)) return 'actor_inactive';
	}
	if (required_roles.length > 0) {
		const refreshed = await refresh_role_grants(request_context, deps);
		if (!has_any_scoped_role(refreshed, required_roles, null)) return 'role_revoked';
	}
	return 'admitted';
};
