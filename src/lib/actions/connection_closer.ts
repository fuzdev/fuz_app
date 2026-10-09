/**
 * Closing live connections — WebSocket and SSE — when the credential behind
 * them is revoked.
 *
 * **Why this exists.** A WebSocket and an SSE stream are authorized once, at
 * open. Per-message WebSocket dispatch (`actions/perform_action.ts`) reloads
 * role grants, never the session or token, and a one-way stream re-reads
 * nothing. So a revocation takes effect on an open connection only when
 * something closes it. `ConnectionCloser` is that capability, and every
 * revocation handler holds one: the session and token revokes, the revoke-alls,
 * account delete and purge, `/logout`, `/password`, and the session and token
 * caps for what they evict. The auth cleanup holds one too
 * (`AuthCleanupDeps.connection_closer`): its session sweep closes the
 * connections of each expired session it deletes, after that delete commits.
 *
 * ## Closing after commit
 *
 * A revocation runs inside a request transaction, and it must not close a
 * connection until that transaction commits. `queue_connection_close` defers
 * the close onto the request's post-commit queue (`emit_after_commit`): it
 * runs after the commit and is dropped on rollback, so a revocation that never
 * happened closes nothing.
 *
 * Two things rest on that order. A client told "revoked" rechecks its session
 * straight away, and before the commit the row it probes is still there. And
 * connection admission registers a connection and then re-reads its
 * credential (`revalidate_resolved_auth`): a close that missed the
 * registration must belong to a revocation the re-read can see, which holds
 * only if the close came after the commit.
 *
 * ## Why the handlers close directly
 *
 * The audit listeners (`create_ws_auth_guard`, `create_sse_auth_guard`) close
 * connections too, but only once the audit row is written, and that write is
 * pool-routed and fail-open. The handler's own close is the one that runs
 * whatever happens to the audit write, so the closer it holds must reach every
 * transport whose connections outlive their credential. `RealtimeCloser` is
 * that fan-out, and `create_app_backend` puts one on `AppDeps`.
 *
 * Twin of the Rust spine's `SocketRevoker`, `SocketCloseTarget`,
 * `queue_socket_close`, and `RealtimeRevoker`.
 *
 * @module
 */

import type { Uuid } from '@fuzdev/fuz_util/id.ts';
import { UnreachableError } from '@fuzdev/fuz_util/error.ts';

import { emit_after_commit, type EmitAfterCommitContext } from '../http/pending_effects.ts';

/**
 * Close live connections by identity, or all of them.
 *
 * Each method returns how many connections it closed. Closing is idempotent:
 * a connection already gone isn't counted, so a handler's close and an audit
 * listener's close on the same revocation compose. Implementations are
 * synchronous.
 *
 * One connection that fails to close must not spare the rest: an
 * implementation attempts every matching connection, then throws the first
 * error it met.
 *
 * `BackendWebsocketTransport` satisfies this structurally, and
 * `create_sse_connection_closer` adapts a `SubscriberRegistry`.
 */
export interface ConnectionCloser {
	/** Close every connection authenticated by the session whose blake3 hash is `session_token_hash`. */
	close_sockets_for_session: (session_token_hash: string) => number;
	/** Close every connection authenticated by the API token `api_token_id`. */
	close_sockets_for_token: (api_token_id: string) => number;
	/**
	 * Close every connection of `account_id`, whatever credential opened it —
	 * the close for a revocation that invalidates all of an account's
	 * credentials.
	 */
	close_sockets_for_account: (account_id: Uuid) => number;
	/**
	 * Close every connection, whoever opened it — the shutdown close
	 * `AppServer.close` runs. Not a revocation: a WebSocket gets
	 * `WS_CLOSE_GOING_AWAY`, so its client reconnects rather than treating
	 * its credential as revoked.
	 */
	close_all_sockets: () => number;
}

/**
 * Which connections a revocation closes — the argument of
 * `queue_connection_close`, one variant per credential close of
 * `ConnectionCloser` (`close_all_sockets` is shutdown, never a revocation).
 */
export type ConnectionCloseTarget =
	| { kind: 'session'; session_token_hash: string }
	| { kind: 'token'; api_token_id: string }
	| { kind: 'account'; account_id: Uuid };

/**
 * Close the connections `target` names, now.
 *
 * A revocation handler calls `queue_connection_close` instead, which runs this
 * after the commit.
 *
 * @returns how many connections closed
 */
export const close_connections = (
	closer: ConnectionCloser,
	target: ConnectionCloseTarget
): number => {
	switch (target.kind) {
		case 'session':
			return closer.close_sockets_for_session(target.session_token_hash);
		case 'token':
			return closer.close_sockets_for_token(target.api_token_id);
		case 'account':
			return closer.close_sockets_for_account(target.account_id);
		default:
			throw new UnreachableError(target);
	}
};

/**
 * Queue a connection close on `ctx`'s post-commit queue, so it runs only after
 * the request's transaction commits and never when the handler throws.
 *
 * The one way a revocation handler closes connections — see the module doc for
 * why an in-transaction revocation must not close inline.
 *
 * In a handler with no wrapping transaction a throw still drops the queued
 * close while an autocommit write stays; close with `close_connections`
 * straight after the write there.
 *
 * @param ctx - the route or action context of the request doing the revoking
 * @param closer - the closer to run, `deps.connection_closer` in a handler
 * @param target - the connections to close
 * @mutates `ctx.post_commit_effects` - appends the close
 */
export const queue_connection_close = (
	ctx: EmitAfterCommitContext,
	closer: ConnectionCloser,
	target: ConnectionCloseTarget
): void => {
	emit_after_commit(ctx, () => {
		close_connections(closer, target);
	});
};

/**
 * A `ConnectionCloser` that closes nothing — for a backend with no
 * live-connection surface, where a revocation has nothing to close.
 */
export const noop_connection_closer: ConnectionCloser = Object.freeze({
	close_sockets_for_session: () => 0,
	close_sockets_for_token: () => 0,
	close_sockets_for_account: () => 0,
	close_all_sockets: () => 0
});

/**
 * One `ConnectionCloser` over every live-connection transport of a backend.
 *
 * Each close fans out to every member and returns the sum of what each
 * closed. A revocation handler holds this rather than one transport, so its
 * close reaches the WebSocket transports and the SSE registries alike, and
 * `AppServer.close` runs its `close_all_sockets` to end every live connection
 * of the backend at shutdown.
 *
 * A member that throws does not stop the fan-out: every member is still
 * called, and the first error is thrown once they all have been — so the
 * caller (the post-commit flush, an audit listener) logs it.
 */
export interface RealtimeCloser extends ConnectionCloser {
	/**
	 * Add a transport's closer, returning a remover for this addition.
	 *
	 * Membership is by reference: a closer added twice — two endpoints
	 * sharing one transport — is one member, and every close reaches it
	 * once. Each `add` is counted, and its remover releases only that count:
	 * the closer stays a member until every addition is removed, so one
	 * owner releasing a shared transport leaves it reachable for the others.
	 * Calling a remover again is a no-op.
	 *
	 * Members must be the same instances connections are registered on — a
	 * closer over a fresh registry closes nothing.
	 *
	 * @param closer - the transport's closer
	 * @returns a remover for this addition, idempotent
	 */
	add: (closer: ConnectionCloser) => () => void;
	/** Count of distinct members — introspection for tests and diagnostics. */
	member_count: () => number;
}

/**
 * Create an empty `RealtimeCloser`.
 *
 * `create_app_backend` creates the one on `AppDeps.connection_closer`, and
 * `create_app_server` adds each WebSocket transport it mounts and its audit
 * stream registry, removing them when its assembly fails or the server
 * closes. A consumer that mounts a transport by hand adds it through
 * the `connection_closer` option of `register_ws_endpoint` /
 * `create_audit_log_sse`, or with `add`.
 */
export const create_realtime_closer = (): RealtimeCloser => {
	// member → how many additions hold it; iteration order is first addition
	const members: Map<ConnectionCloser, number> = new Map();
	const fan_out = (close: (member: ConnectionCloser) => number): number => {
		let count = 0;
		let failed = false;
		let first_error: unknown;
		for (const member of members.keys()) {
			try {
				count += close(member);
			} catch (error) {
				// keep going — one transport's failure must not leave another's
				// connections open on a revoked credential
				if (!failed) {
					failed = true;
					first_error = error;
				}
			}
		}
		if (failed) throw first_error;
		return count;
	};
	return Object.freeze({
		add: (closer: ConnectionCloser): (() => void) => {
			members.set(closer, (members.get(closer) ?? 0) + 1);
			let removed = false;
			return () => {
				if (removed) return;
				removed = true;
				const count = members.get(closer);
				if (count === undefined) return;
				if (count <= 1) members.delete(closer);
				else members.set(closer, count - 1);
			};
		},
		member_count: (): number => members.size,
		close_sockets_for_session: (session_token_hash: string): number =>
			fan_out((member) => member.close_sockets_for_session(session_token_hash)),
		close_sockets_for_token: (api_token_id: string): number =>
			fan_out((member) => member.close_sockets_for_token(api_token_id)),
		close_sockets_for_account: (account_id: Uuid): number =>
			fan_out((member) => member.close_sockets_for_account(account_id)),
		close_all_sockets: (): number => fan_out((member) => member.close_all_sockets())
	});
};
