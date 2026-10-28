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
 * caps for what they evict. A role revocation is the exception: it closes
 * only the connections an endpoint gated on that role, and only through the
 * audit listener (`create_revocation_guard`) — no handler holds a closer for
 * it. The auth cleanup holds one too
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
 * The audit listener (`create_revocation_guard`) closes connections too, but
 * only once the audit row is written, and that write is pool-routed and
 * fail-open. The handler's own close is the one that runs
 * whatever happens to the audit write, so the closer it holds must reach every
 * transport whose connections outlive their credential. `RealtimeCloser` is
 * that fan-out, and `create_app_backend` puts one on `AppDeps`.
 *
 * ## The audit listener
 *
 * `create_revocation_guard` repeats a revocation's close when its audit row is
 * announced, which covers a revocation emitted by code that holds no closer,
 * and is the one closer of a role revocation. `create_app_server` registers one
 * on `deps.connection_closer` when it mounts a WebSocket endpoint or the audit
 * stream, so it reaches every member — each WebSocket transport and the audit
 * stream registry — through the one fan-out.
 *
 * Twin of the Rust spine's `ConnectionCloser`, `ConnectionCloseTarget`,
 * `queue_connection_close`, `RealtimeCloser`, and
 * `register_revocation_guard`.
 *
 * @module
 */

import type { Uuid } from '../primitive_schemas.ts';
import { UnreachableError } from '@fuzdev/fuz_util/error.ts';
import type { Logger } from '@fuzdev/fuz_util/log.ts';

import { emit_after_commit, type EmitAfterCommitContext } from '../http/pending_effects.ts';
import {
	to_global_role_revocation,
	to_revocation_scope,
	type AuditLogEvent
} from '../auth/audit_log_schema.ts';

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
 * `create_sse_connection_closer` adapts a `SubscriberRegistry`. Twin of the
 * Rust spine's `ConnectionCloser` (with its `ShutdownCloser` supertrait's
 * `close_all_connections`).
 */
export interface ConnectionCloser {
	/**
	 * Close every connection `target` names — pending admission or admitted.
	 *
	 * A revocation handler calls `queue_connection_close` instead, which runs
	 * this after the commit.
	 */
	close_connections: (target: ConnectionCloseTarget) => number;
	/**
	 * Close every connection, whoever opened it — the shutdown close
	 * `AppServer.close` runs. Not a revocation: a WebSocket gets
	 * `WS_CLOSE_GOING_AWAY`, so its client reconnects rather than treating
	 * its credential as revoked. The transport is left closing: a
	 * registration that arrives afterward is born closed, refused at once
	 * (`BackendWebsocketTransport` and `SubscriberRegistry` both do).
	 */
	close_all_connections: () => number;
}

/**
 * Which connections a revocation closes — the argument of
 * `ConnectionCloser.close_connections` and `queue_connection_close`.
 * Twin of the Rust spine's `ConnectionCloseTarget`, the same four variants.
 *
 * - `session` — every connection authenticated by the session whose blake3
 *   hash is `session_hash` (`ConnectionIdentity.session_hash`)
 * - `token` — every connection authenticated by the API token `api_token_id`
 * - `account` — every connection of `account_id`, whatever credential opened
 *   it: the close for a revocation that invalidates all of an account's
 *   credentials
 * - `role` — the connections of `account_id` whose endpoint gated them on
 *   `role`: the close for a revoked **global** grant of that role (a scoped
 *   grant never admits at a role gate, so revoking one closes nothing;
 *   `to_connection_close_target` filters). A WebSocket gets
 *   `WS_CLOSE_PERMISSION_REVOKED`, not a revocation's code: the credential is
 *   still good. It **over-closes an any-of gate**: a connection whose
 *   endpoint listed several roles closes on the loss of any of them, whether
 *   or not the account still holds another; the client reconnects into the
 *   gate if it still qualifies. No handler queues `role`: the audit listener
 *   is a role's only closer.
 */
export type ConnectionCloseTarget =
	| { kind: 'session'; session_hash: string }
	| { kind: 'token'; api_token_id: string }
	| { kind: 'account'; account_id: Uuid }
	| { kind: 'role'; account_id: Uuid; role: string };

/**
 * The connections a revocation's audit row closes, dispatched on the
 * `RevocationScope` its event declares in `audit_event_revocation_scopes`
 * (`auth/audit_log_schema.ts`) — `null` when it closes nothing:
 *
 * - a row whose outcome is not `success` — a failure carries
 *   attacker-controlled identifiers (a `session_revoke` the DB rejected still
 *   records the submitted session id), so reacting to it would let any
 *   authenticated caller close another user's connection by guessing a session
 *   hash or token id; matching the success rather than skipping the failure
 *   keeps an outcome outside the enum inert
 * - scope `none` — every event that revokes nothing, and any event type
 *   fuz_app does not define
 * - a row missing the key its scope closes by (an empty string included)
 * - a `role` row whose revoked grant was scoped (`to_global_role_revocation`)
 *
 * Otherwise:
 *
 * - `session` → `{kind: 'session', session_hash: metadata.session_id}`
 * - `token` → `{kind: 'token', api_token_id: metadata.token_id}`
 * - `account` → `{kind: 'account', account_id: target_account_id ?? account_id}`
 *   — admin actions set `target_account_id`, self-service ones only
 *   `account_id`
 * - `role` → `{kind: 'role', account_id, role}` of the revoked global grant
 *
 * Twin of the Rust spine's `ConnectionCloseTarget::from_audit_event`.
 *
 * @param event - the audit row announced after its commit
 * @returns the connections to close, or `null`
 */
export const to_connection_close_target = (event: AuditLogEvent): ConnectionCloseTarget | null => {
	if (event.outcome !== 'success') return null;
	const scope = to_revocation_scope(event.event_type);
	switch (scope) {
		case 'none':
			return null;
		case 'session': {
			const session_id = event.metadata?.session_id;
			if (typeof session_id !== 'string' || session_id.length === 0) return null;
			return { kind: 'session', session_hash: session_id };
		}
		case 'token': {
			const token_id = event.metadata?.token_id;
			if (typeof token_id !== 'string' || token_id.length === 0) return null;
			return { kind: 'token', api_token_id: token_id };
		}
		case 'account': {
			const account_id = event.target_account_id ?? event.account_id;
			if (!account_id) return null;
			return { kind: 'account', account_id };
		}
		case 'role': {
			// global grants only — a role gate never admitted on a scoped one
			const revoked = to_global_role_revocation(event);
			if (!revoked) return null;
			return { kind: 'role', account_id: revoked.account_id, role: revoked.role };
		}
		default:
			throw new UnreachableError(scope);
	}
};

/**
 * The log text for a close target — `session <hash>`, `token <id>`,
 * `account <id>`, `role <role> of account <id>`.
 */
const format_connection_close_target = (target: ConnectionCloseTarget): string => {
	switch (target.kind) {
		case 'session':
			return `session ${target.session_hash}`;
		case 'token':
			return `token ${target.api_token_id}`;
		case 'account':
			return `account ${target.account_id}`;
		case 'role':
			return `role ${target.role} of account ${target.account_id}`;
		default:
			throw new UnreachableError(target);
	}
};

/**
 * Close the connections `target` names, now, for a revocation that has
 * already committed — logging a close that throws instead of throwing it.
 *
 * For a handler with no route transaction, closing straight after its own
 * commit: a throw there would fail a request whose revocation stands, and skip
 * the work after the close (the response, the audit row). A closer over several
 * transports closes the rest before it rethrows, so catching loses no close.
 * The twin of the post-commit flush, which catches and logs the same way.
 *
 * @param closer - the closer to run, `deps.connection_closer` in a handler
 * @param target - the connections to close
 * @param log - where a failing close is reported
 */
export const close_connections_after_commit = (
	closer: ConnectionCloser,
	target: ConnectionCloseTarget,
	log: Logger
): void => {
	try {
		closer.close_connections(target);
	} catch (err) {
		log.error('connection close after commit failed:', err);
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
 * close while an autocommit write stays; such a handler closes inline straight
 * after its own commit instead, with `close_connections_after_commit`, which
 * catches and logs a failing close as the post-commit flush does.
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
		closer.close_connections(target);
	});
};

/**
 * A `ConnectionCloser` that closes nothing — for a backend with no
 * live-connection surface, where a revocation has nothing to close.
 */
export const noop_connection_closer: ConnectionCloser = Object.freeze({
	close_connections: () => 0,
	close_all_connections: () => 0
});

/**
 * One `ConnectionCloser` over every live-connection transport of a backend.
 *
 * Each close fans out to every member and returns the sum of what each
 * closed. A revocation handler holds this rather than one transport, so its
 * close reaches the WebSocket transports and the SSE registries alike, and
 * `AppServer.close` runs its `close_all_connections` to end every live connection
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
 * the `connection_closer` option of `register_action_ws` /
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
		close_connections: (target: ConnectionCloseTarget): number =>
			fan_out((member) => member.close_connections(target)),
		close_all_connections: (): number => fan_out((member) => member.close_all_connections())
	});
};

/**
 * Audit-event callback shape — the function `CreateAuditEmitterOptions.on_audit_event`
 * accepts, `AuditEmitter.add_listener` registers, and `create_revocation_guard`
 * returns.
 */
export type AuditEventHandler = (event: AuditLogEvent) => void;

/**
 * Create the audit listener that closes live connections on a successful
 * revocation row: `to_connection_close_target` maps the row to the
 * connections it names, and the listener closes them with
 * `closer.close_connections`.
 *
 * **Why it exists beside the handlers' own closes.** The revocation handlers
 * close after their commit (`queue_connection_close`), whatever happens to the
 * audit write; this listener repeats that close when the row is announced,
 * which covers a revocation emitted by code that holds no closer. Closing is
 * idempotent, so the overlap is a repeat. A success row is announced only after
 * its request's transaction commits (`auth/audit_emitter.ts`), so this close is
 * post-commit too, and it reaches connections still pending admission.
 *
 * **The role close.** `perform_action` re-authorizes every request against its
 * own action, but an endpoint's role gate is the only check on what its
 * connections *receive* — WebSocket broadcasts and notifications, the audit
 * stream's rows — with no per-recipient filter, so a connection left open past
 * the revocation would keep receiving what the gate exists to withhold. No
 * handler closes for a role, so this listener is its one closer: a WebSocket
 * closes with `WS_CLOSE_PERMISSION_REVOKED`, a stream gated on the role ends.
 *
 * Twin of the Rust spine's `register_revocation_guard`.
 *
 * @param closer - what to close on — `deps.connection_closer`, the fan-out over
 *   every transport, which is what `create_app_server` registers it on
 * @param log - logger for the closes (info level, when any connection closed)
 * @returns an `on_audit_event` callback for `create_audit_emitter`, or for
 *   `AuditEmitter.add_listener`
 */
export const create_revocation_guard = (
	closer: ConnectionCloser,
	log: Logger
): AuditEventHandler => {
	return (event: AuditLogEvent): void => {
		const target = to_connection_close_target(event);
		if (!target) return;
		const closed = closer.close_connections(target);
		if (closed > 0) {
			log.info(
				`revocation guard: closed ${closed} connection(s) for ${format_connection_close_target(target)} (${event.event_type})`
			);
		}
	};
};
