/**
 * Backend WebSocket transport — manages server-side WebSocket connections
 * with session tracking, revocation support, a per-account connection cap,
 * and two-phase registration.
 *
 * ## Two-phase registration
 *
 * An upgrade resolves its credential before the socket exists, and every
 * revocation closes the connections *registered* under the revoked
 * credential. A one-step registration therefore has a window: a revocation
 * landing between the credential check and the insert closes nothing, and the
 * upgrade is admitted on a dead credential — for the socket's lifetime, since
 * per-message dispatch never re-reads the session or token.
 *
 * Registration is split to close it:
 *
 * 1. `BackendWebsocketTransport.register_pending` inserts the entry
 *    **un-admitted**. It is closeable from that instant — `close_sockets_for_*`
 *    match pending entries deliberately — and is otherwise inert: it evicts
 *    nothing, the cap does not count it, no broadcast / `send_to_account` /
 *    `request_connection` reaches it, and the count accessors and
 *    `is_registered` do not see it (`get_pending_connection_count` does).
 * 2. The caller re-checks the credential against the database
 *    (`revalidate_resolved_auth` in `auth/resolved_auth.ts`).
 * 3. `BackendWebsocketTransport.admit` flips the entry to admitted — or
 *    refuses when a revocation closed it in the meantime, evicting nothing.
 *    The cap's eviction happens here, so a connection that is never admitted
 *    never closes a live one, and any number of pending registrations on one
 *    account leave its admitted connections alone.
 *
 * A revocation whose close ran **after** step 1 finds the entry, pending or
 * admitted, and closes it; one that **committed before** step 2 is seen by the
 * re-read, which refuses. Nothing is delivered to a pending entry rather than
 * queued for it, so a refusal never has to promise that a queue a revoked
 * credential would have read is dropped unread, and a broadcast's returned
 * count names only connections that can receive it. The cost is a slightly
 * wider blind spot at connect: a server-initiated message sent between the
 * handshake and admission — one credential re-check later — is not delivered,
 * just as one sent before the handshake is not.
 *
 * `add_connection` stays as the one-step form (register and admit together)
 * for a connection with no revocable credential behind it — tests and
 * harnesses that register a socket directly. An upgrade that authenticated a session or token
 * uses the two-phase form. The twin of the Rust `fuz_realtime`
 * `ConnectionRegistry`.
 *
 * ## Outbound bound
 *
 * Every frame the server sends a connection goes through one path —
 * `send_to`, which responses, error frames and socket-scoped notifications
 * use, and the fan-outs (`broadcast`, `broadcast_filtered`, `send_to_account`,
 * `request_connection`) — into the connection's `WsOutboundWriter`
 * (`actions/ws_outbound_writer.ts`). A send never waits and never throws: one
 * recipient that stopped reading must not slow a producer or another
 * recipient.
 *
 * What waits for a socket is held to a byte budget, `outbound_queue_bytes`
 * (`DEFAULT_WS_OUTBOUND_QUEUE_BYTES`): each waiting frame is charged its UTF-8
 * length plus `OUTBOUND_FRAME_OVERHEAD_BYTES`, and a frame is always accepted
 * when nothing is waiting. Nothing counts frames. A frame sent to an idle
 * connection goes straight to the socket; the rest of a burst sent in one
 * synchronous run waits, as does anything sent while the socket's own buffer
 * is backed up.
 *
 * A frame that does not fit **closes the connection** rather than being
 * dropped alone: the connection is removed in the same synchronous step — the
 * overflowing send does not count it, later sends miss it, the count accessors
 * and the cap no longer see it — its controller is aborted, what was waiting
 * is discarded, and the socket is closed with `WS_CLOSE_OUTBOUND_OVERFLOW`.
 * Frames already handed to the socket may still reach the client ahead of the
 * close frame; nothing follows it, the response of the request whose handler
 * overflowed the connection included. One `warn` line names the connection,
 * its account, and what was waiting; no audit row is written — a client can
 * provoke an overflow at will, and a write per overflow would amplify it.
 *
 * A socket that holds unwritten bytes past `WS_WRITE_STALL_TIMEOUT` is dropped
 * with no close frame, and removed the same way, with one `warn` line. Every
 * other close the transport makes (a revocation, the cap, the shutdown,
 * `close_connection`) hands the frames still waiting to the socket ahead of
 * its close frame while the socket's buffer is below
 * `WS_WRITE_HIGH_WATER_BYTES`, discards the rest, and cuts the socket if the
 * close frame is still unwritten after `WS_CLOSE_WRITE_TIMEOUT`. A reply sent
 * to an otherwise idle connection just before such a close reaches the client;
 * one queued behind a backed-up socket does not.
 *
 * A connection the transport closed or dropped is out of its map, so the
 * per-account cap does not count it while its socket is still closing. What
 * the runtime holds for such a socket is bounded by the writer
 * (`actions/ws_outbound_writer.ts`, "Closing" and "Runtimes").
 *
 * The twin of the Rust `fuz_realtime` outbound queue — same budget, charge,
 * close code and deadlines. Where they differ: the Rust spine discards every
 * frame queued before any close, and queues every frame, where this transport
 * writes the first frame of a run straight through and, at a close that is
 * not an overflow, the waiting frames its socket has room for.
 *
 * ## Shutdown
 *
 * `close_all_sockets` — the close `AppServer.close` runs — closes every
 * connection, pending or admitted, with `WS_CLOSE_GOING_AWAY`, and leaves the
 * transport **closing**: from then on every registration is born closed. A
 * `register_pending` or `add_connection` inserts nothing — it aborts the
 * caller's controller and closes the socket with `WS_CLOSE_GOING_AWAY` at once
 * — so an upgrade still in flight when the server shuts down is closed rather
 * than outliving it. An upgrade registered before the close-all is closed by
 * it; one registered after is born closed; none is admitted. The flag is set
 * in the same synchronous step that closes the live connections, so an `admit`
 * that finds its entry gone and reads `is_closing()` sees the shutdown — a
 * shutdown is never read as a revocation (a revocation the shutdown overtook
 * reads as the shutdown). Closing is permanent: a closed transport hosts no
 * further connections.
 *
 * @module
 */

import type { WSContext } from 'hono/ws';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { create_uuid, type Uuid } from '../primitive_schemas.ts';

import type {
	JsonrpcMessageFromServerToClient,
	JsonrpcNotification,
	JsonrpcRequestParams,
	JsonrpcResponse,
	JsonrpcErrorResponse
} from '../http/jsonrpc.ts';
import { create_jsonrpc_request } from '../http/jsonrpc_helpers.ts';
import {
	WS_CLOSE_CONNECTION_LIMIT,
	WS_CLOSE_GOING_AWAY,
	WS_CLOSE_GOING_AWAY_REASON,
	WS_CLOSE_OUTBOUND_OVERFLOW,
	WS_CLOSE_OUTBOUND_OVERFLOW_REASON,
	WS_CLOSE_PERMISSION_REVOKED,
	WS_CLOSE_PERMISSION_REVOKED_REASON,
	WS_CLOSE_SESSION_REVOKED,
	WS_CLOSE_SESSION_REVOKED_REASON,
	utf8_length
} from './transports.ts';
import {
	PendingPeerRequests,
	type PeerRequestOptions,
	type PeerRequestOutcome
} from './peer_request.ts';
import {
	WsOutboundWriter,
	type WsOutboundBacklog,
	type WsOutboundStall
} from './ws_outbound_writer.ts';
import type { OutboundOverflow } from '../realtime/outbound_budget.ts';

// TODO support a SSE backend transport

/**
 * Auth identity attached to a single WebSocket connection.
 *
 * One record per connection. `token_hash` is set for cookie-session
 * connections, `api_token_id` for bearer (`api_token`) connections, and
 * both are null for daemon-token connections (reachable only via
 * `BackendWebsocketTransport.close_sockets_for_account`). `required_roles`
 * is what the connection's endpoint gated the upgrade on, kept per
 * registration because endpoints with different gates can share one
 * transport.
 */
export interface ConnectionIdentity {
	/** Blake3 session token hash, or null for non-session credentials. */
	token_hash: string | null;
	/** Authenticated account id. Always set. */
	account_id: Uuid;
	/** `api_token.id` for bearer-authenticated connections, else null. */
	api_token_id: string | null;
	/**
	 * The roles the endpoint required at upgrade (any-of), or empty for an
	 * ungated endpoint — what `close_sockets_for_role` matches on.
	 */
	required_roles: ReadonlyArray<string>;
}

/**
 * Default per-account WebSocket connection cap, applied by
 * `BackendWebsocketTransport` unless overridden via
 * `BackendWebsocketTransportOptions.max_connections_per_account`.
 *
 * Matches the account-wide ceiling the audit SSE cap implies (the default
 * session cap, `DEFAULT_MAX_SESSIONS`, times `AUDIT_LOG_SSE_MAX_PER_SCOPE`
 * streams per session) — generous enough that a user's tabs and tools never
 * meet it; only an abusive or leaking client does. The twin of the Rust
 * spine's `DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT`.
 */
export const DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT = 50;

/**
 * Default byte budget of the frames waiting to be written to one connection,
 * applied by `BackendWebsocketTransport` unless overridden via
 * `BackendWebsocketTransportOptions.outbound_queue_bytes`.
 *
 * 4 MiB — four messages at `DEFAULT_WS_MAX_MESSAGE_BYTES` as it stands, and a
 * value of its own: it does not move with the inbound message cap. A consumer
 * whose server pushes more than this at a client in one burst — large frames,
 * or long runs of them — sets its own. Same value as the Rust spine's
 * `DEFAULT_WS_OUTBOUND_QUEUE_BYTES`.
 */
export const DEFAULT_WS_OUTBOUND_QUEUE_BYTES = 4 * 1024 * 1024;

/** Options for `BackendWebsocketTransport`. */
export interface BackendWebsocketTransportOptions {
	/**
	 * Max concurrent connections per `account_id`, across every credential
	 * type (session, API token, daemon token — none exempt). The policy is
	 * **evict-oldest**: a connection past the cap is always admitted, and the
	 * account's oldest connections are closed with `WS_CLOSE_CONNECTION_LIMIT`
	 * to make room. Refusing the new one instead would let half-open sockets
	 * lock a user out with their own dead connections, and would let a stolen
	 * credential fill the slots ahead of the real user — revocation is the fix
	 * for a stolen credential, and evict-oldest never stands in its way.
	 *
	 * The cap is per transport: endpoints sharing one transport share one
	 * count per account. `null` disables it.
	 *
	 * @default DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT
	 */
	max_connections_per_account?: number | null;
	/**
	 * Byte budget of the frames waiting to be written to one connection. Each
	 * waiting frame is charged its UTF-8 length plus
	 * `OUTBOUND_FRAME_OVERHEAD_BYTES`; a frame that does not fit closes the
	 * connection with `WS_CLOSE_OUTBOUND_OVERFLOW`, and a frame is always
	 * accepted when nothing is waiting, so one message larger than the whole
	 * budget is still deliverable (module doc, "Outbound bound"). Not derived
	 * from the inbound message cap.
	 *
	 * @default DEFAULT_WS_OUTBOUND_QUEUE_BYTES
	 */
	outbound_queue_bytes?: number;
	/**
	 * Logger for cap evictions, outbound overflows and stalls, and failed sends
	 * or closes. An overflow or a stall logs one `warn` line — the connection,
	 * its account, and what was waiting. A cap eviction logs
	 * at info — the account, how many connections were closed, and the cap —
	 * so an operator can see a client that keeps meeting it. Unset falls back
	 * to a `[ws]` logger; `null` silences it. `register_action_ws` passes its
	 * own logger to the transport it creates.
	 */
	log?: Logger | null;
}

/** One registered connection — its socket, auth identity, and admission state. */
interface ConnectionEntry {
	ws: WSContext;
	identity: ConnectionIdentity;
	/**
	 * `false` between `register_pending` and `admit`. An un-admitted entry
	 * exists only so a revocation can find and close it: it receives nothing, is
	 * not counted, and never weighs on the per-account cap.
	 */
	admitted: boolean;
	/**
	 * The socket-scoped controller the caller registered, aborted when the
	 * transport closes the connection (revocation or cap eviction) so in-flight
	 * handlers see `signal.aborted` at once rather than when the close handshake
	 * lands.
	 */
	abort_controller: AbortController | null;
	/** The connection's outbound queue and write pump — every send goes through it. */
	writer: WsOutboundWriter;
}

export class BackendWebsocketTransport {
	// Per-account connection cap; `null` = uncapped.
	readonly #max_connections_per_account: number | null;

	// Byte budget of each connection's waiting frames.
	readonly #outbound_queue_bytes: number;

	readonly #log: Logger | null;

	// One entry per registered connection, pending or admitted, in
	// registration order (Map iteration is insertion order — the cap's
	// "oldest"). Adding a new identity scope (e.g. `device_id`) means adding a
	// field to `ConnectionIdentity`, not a parallel map.
	#connections: Map<Uuid, ConnectionEntry> = new Map();

	// Writers of connections the transport has closed, until their socket's
	// close arrives (`remove_connection`) or the close deadline passes — so the
	// deadline timer is cleared when the socket goes.
	#closing_writers: Map<Uuid, WsOutboundWriter> = new Map();

	// The close code each registration the transport closed while it was still
	// pending got, until `take_pending_close_code` or `remove_connection` drops
	// it — so a refused admission can say why it was refused.
	#pending_close_codes: Map<Uuid, number> = new Map();

	// set once by `close_all_sockets`, never cleared — every later
	// registration is born closed (module doc, "Shutdown")
	#closing = false;

	// Server→client request correlation (ActionPeer). The transport owns the
	// sockets + the send; the registry owns the pending map, id allocation,
	// deadlines, and the per-connection in-flight cap (see `peer_request.ts`).
	#pending: PendingPeerRequests = new PendingPeerRequests();

	/**
	 * @throws Error when `max_connections_per_account` is neither `null` nor a
	 *   positive integer, or `outbound_queue_bytes` is not a positive integer
	 */
	constructor(options?: BackendWebsocketTransportOptions) {
		const max =
			options?.max_connections_per_account === undefined
				? DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT
				: options.max_connections_per_account;
		if (max !== null && (!Number.isInteger(max) || max < 1)) {
			throw new Error(
				`BackendWebsocketTransport: max_connections_per_account must be a positive integer or null, got ${max}`
			);
		}
		this.#max_connections_per_account = max;
		const outbound_queue_bytes = options?.outbound_queue_bytes ?? DEFAULT_WS_OUTBOUND_QUEUE_BYTES;
		if (!Number.isSafeInteger(outbound_queue_bytes) || outbound_queue_bytes < 1) {
			// zero would close a connection for the first frame queued behind one
			// still waiting
			throw new Error(
				`BackendWebsocketTransport: outbound_queue_bytes must be a positive integer, got ${outbound_queue_bytes}`
			);
		}
		this.#outbound_queue_bytes = outbound_queue_bytes;
		this.#log = options?.log === undefined ? new Logger('[ws]') : options.log;
	}

	/**
	 * Register a connection **un-admitted** — phase one of the two-phase
	 * registration an upgrade runs (module doc).
	 *
	 * The entry is closeable at once: a `close_sockets_for_*` matching
	 * `token_hash` / `account_id` / `api_token_id` removes it, aborts
	 * `abort_controller`, and closes `ws` with `WS_CLOSE_SESSION_REVOKED`
	 * (`close_sockets_for_role`, matching `required_roles`, with
	 * `WS_CLOSE_PERMISSION_REVOKED`); the later `admit` then refuses. Until admitted it evicts nothing, is not
	 * counted toward the per-account cap, and receives no message.
	 *
	 * The caller owns the entry until it is admitted: a refusal closes it with
	 * `close_connection`, and `remove_connection` drops it once its socket has
	 * closed.
	 *
	 * Once the transport is closing (`close_all_sockets`) the registration is
	 * born closed: nothing is inserted, `abort_controller` is aborted, and `ws`
	 * is closed with `WS_CLOSE_GOING_AWAY` before this returns. The id names
	 * nothing, so `admit` refuses it (module doc, "Shutdown").
	 *
	 * @param ws - the socket to close on revocation
	 * @param token_hash - blake3 session token hash, or `null` for non-session credentials
	 * @param account_id - the authenticated account
	 * @param api_token_id - `api_token.id` for bearer connections, else `null`
	 * @param abort_controller - the socket-scoped controller to abort when the
	 *   transport closes this connection (revocation or cap eviction)
	 * @param required_roles - the roles the endpoint gated the upgrade on, for
	 *   `close_sockets_for_role`; empty for an ungated endpoint
	 * @returns the freshly assigned `connection_id` (branded `Uuid`)
	 * @mutates this - inserts an un-admitted entry into `#connections`, unless
	 *   the transport is closing
	 */
	register_pending(
		ws: WSContext,
		token_hash: string | null,
		account_id: Uuid,
		api_token_id: string | null = null,
		abort_controller: AbortController | null = null,
		required_roles: ReadonlyArray<string> = []
	): Uuid {
		if (this.#closing) return this.#close_born_closed(ws, abort_controller);
		return this.#insert(
			ws,
			{ token_hash, account_id, api_token_id, required_roles },
			abort_controller,
			false
		);
	}

	/**
	 * The close code the transport closed a still-pending registration with —
	 * `WS_CLOSE_SESSION_REVOKED` for a credential revocation,
	 * `WS_CLOSE_PERMISSION_REVOKED` for a role close, `WS_CLOSE_GOING_AWAY`
	 * for the shutdown — read once: the record is dropped by this call (and by
	 * `remove_connection`). `null` when the transport did not close it while
	 * pending. For a caller whose `admit` was refused, to say why; the twin of
	 * the reason the Rust `ConnectionRegistry::admit` refuses with.
	 *
	 * @param connection_id - the id `register_pending` returned
	 * @returns the close code, or `null`
	 * @mutates this - drops the recorded code
	 */
	take_pending_close_code(connection_id: Uuid): number | null {
		const code = this.#pending_close_codes.get(connection_id);
		if (code === undefined) return null;
		this.#pending_close_codes.delete(connection_id);
		return code;
	}

	/**
	 * Admit a pending connection — phase two (module doc).
	 *
	 * If the entry is gone — a revocation closed it while it was pending, or it
	 * was removed — nothing is evicted and the connection is refused. Otherwise
	 * the per-account cap is enforced exactly as in `add_connection`, counting
	 * only **admitted** connections, and the entry becomes admitted: it now
	 * receives messages, is counted, and can itself be superseded. Admitting an
	 * already-admitted connection is a no-op that answers `true`.
	 *
	 * @param connection_id - the id `register_pending` returned
	 * @returns `false` when the connection is no longer registered — the caller
	 *   closes the socket as revoked
	 * @mutates this - marks the entry admitted; past the cap, first removes the
	 *   account's oldest admitted connections and closes their `WSContext`
	 */
	admit(connection_id: Uuid): boolean {
		const entry = this.#connections.get(connection_id);
		if (!entry) return false;
		if (entry.admitted) return true;
		// the entry itself is un-admitted, so the eviction neither counts nor
		// removes it
		if (this.#max_connections_per_account !== null) {
			this.#evict_oldest_for_account(entry.identity.account_id, this.#max_connections_per_account);
		}
		entry.admitted = true;
		return true;
	}

	/**
	 * Register a connection, admitted at once — the one-step form of
	 * `register_pending` + `admit`.
	 *
	 * **Not for an upgrade that authenticated a revocable credential**: a
	 * revocation landing between that upgrade's credential check and this call
	 * closes nothing, and the connection would be admitted on a dead credential
	 * (module doc, "Two-phase registration"). This is for a connection with
	 * nothing to revoke behind it.
	 *
	 * Session connections pass a token hash for targeted revocation.
	 * Bearer token connections (`api_token`) pass the `api_token.id` so the
	 * socket can be closed when that specific token is revoked without
	 * tearing down the account's other sockets. Daemon-token connections
	 * pass `null` for both — they're only reachable via
	 * `close_sockets_for_account`.
	 *
	 * Enforces the per-account cap (`max_connections_per_account`): when
	 * `account_id` already holds the maximum, its oldest admitted connections are
	 * removed and sent a `WS_CLOSE_CONNECTION_LIMIT` close before the new one is
	 * inserted. A removed connection gets no further broadcast or peer request,
	 * stops counting toward the cap at once, and has its `abort_controller`
	 * aborted; its socket is closed when the close handshake completes. The new
	 * connection is always admitted — unless the transport is closing: then it
	 * is born closed, as in `register_pending`, and evicts nothing.
	 *
	 * @param required_roles - the roles the endpoint gated the connection on,
	 *   for `close_sockets_for_role`; empty for an ungated one
	 * @returns the freshly assigned `connection_id` (branded `Uuid`)
	 * @mutates this - inserts an admitted entry into `#connections`; past the
	 *   cap, first removes the account's oldest admitted connections and closes
	 *   their `WSContext`
	 */
	add_connection(
		ws: WSContext,
		token_hash: string | null,
		account_id: Uuid,
		api_token_id: string | null = null,
		abort_controller: AbortController | null = null,
		required_roles: ReadonlyArray<string> = []
	): Uuid {
		if (this.#closing) return this.#close_born_closed(ws, abort_controller);
		if (this.#max_connections_per_account !== null) {
			this.#evict_oldest_for_account(account_id, this.#max_connections_per_account);
		}
		return this.#insert(
			ws,
			{ token_hash, account_id, api_token_id, required_roles },
			abort_controller,
			true
		);
	}

	#insert(
		ws: WSContext,
		identity: ConnectionIdentity,
		abort_controller: AbortController | null,
		admitted: boolean
	): Uuid {
		const connection_id = create_uuid();
		this.#connections.set(connection_id, {
			ws,
			identity,
			admitted,
			abort_controller,
			writer: new WsOutboundWriter({
				ws,
				max_bytes: this.#outbound_queue_bytes,
				on_stall: (stall) => this.#drop_stalled(connection_id, stall),
				log: this.#log
			})
		});
		return connection_id;
	}

	/**
	 * Remove a connection and its auth tracking data, pending or admitted, by
	 * the id `register_pending` / `add_connection` returned. Idempotent — safe
	 * to call after revocation or a cap eviction has already cleaned up, and a
	 * no-op for an unknown id.
	 *
	 * Keyed by id rather than by `WSContext` because a runtime adapter may hand
	 * each socket event its own context object (`@hono/bun` does), so the one a
	 * close event carries can't identify the connection.
	 *
	 * Removal only: the socket is not closed and the registered
	 * `abort_controller` is not aborted — the caller that ends a socket does
	 * both. What was waiting to be written to it is dropped.
	 *
	 * For a socket that has closed (an adapter's close event): on a connection
	 * the transport closed it also drops the close deadline, so calling it while
	 * that socket is still closing leaves a client that is not reading uncut.
	 *
	 * @mutates this - deletes the connection's entry from `#connections`, drops
	 *   its waiting frames and write deadlines, and settles its pending peer
	 *   requests as `connection_gone`
	 */
	remove_connection(connection_id: Uuid): void {
		this.#pending_close_codes.delete(connection_id);
		this.#connections.get(connection_id)?.writer.dispose();
		// a connection the transport closed: its socket is gone now
		const closing = this.#closing_writers.get(connection_id);
		if (closing) {
			closing.dispose();
			this.#closing_writers.delete(connection_id);
		}
		this.#cleanup_connection(connection_id);
	}

	/**
	 * Close one connection, pending or admitted, with `code` and `reason` — the
	 * close `register_action_ws` makes for a heartbeat timeout, an oversized
	 * message, a failed `on_socket_open`, and a refused admission.
	 *
	 * The connection is removed and its controller aborted at once; frames still
	 * waiting for the socket are handed to it ahead of the close frame while its
	 * buffer has room and discarded otherwise, and the close frame is held to
	 * `WS_CLOSE_WRITE_TIMEOUT` (module doc, "Outbound bound"). A socket whose
	 * `close` throws is logged, not thrown.
	 *
	 * @param connection_id - the id `register_pending` / `add_connection` returned
	 * @param code - the close code
	 * @param reason - the close reason
	 * @returns `false` when the connection is not registered — nothing was closed
	 * @mutates this - removes the connection, aborts its registered controller,
	 *   and closes its `WSContext`
	 */
	close_connection(connection_id: Uuid, code: number, reason: string): boolean {
		const entry = this.#connections.get(connection_id);
		if (!entry) return false;
		try {
			this.#end_connection(connection_id, entry, code, reason);
		} catch (error) {
			this.#log?.error(`error closing client with ${code}:`, error);
		}
		return true;
	}

	/**
	 * Close every connection whose identity matches the predicate — pending or
	 * admitted. Never filter on admission here: reaching a registration in
	 * flight is the point of the pending phase, and `admit` then refuses it.
	 *
	 * A socket whose `close` throws does not stop the loop: every match is
	 * removed and closed, and the first error is thrown afterward. The failing
	 * socket's connection is already removed and its handlers aborted, so
	 * nothing more is dispatched or delivered on it.
	 *
	 * @param predicate - which connections to close
	 * @param code - the close code each socket gets
	 * @param reason - the close reason each socket gets
	 * @returns the number of sockets closed
	 * @throws the first error a socket's `close` threw, after every match was attempted
	 */
	#close_where(
		predicate: (identity: ConnectionIdentity) => boolean,
		code: number = WS_CLOSE_SESSION_REVOKED,
		reason: string = WS_CLOSE_SESSION_REVOKED_REASON
	): number {
		let count = 0;
		let failed = false;
		let first_error: unknown;
		// deleting the current entry during Map iteration is safe
		for (const [connection_id, entry] of this.#connections) {
			if (predicate(entry.identity)) {
				try {
					this.#end_connection(connection_id, entry, code, reason);
					count++;
				} catch (error) {
					if (!failed) {
						failed = true;
						first_error = error;
					}
				}
			}
		}
		if (failed) throw first_error;
		return count;
	}

	/**
	 * Close all sockets associated with a specific session token hash,
	 * including a registration still pending admission.
	 *
	 * @returns the number of sockets closed
	 * @mutates this - removes matching connections, aborts their registered
	 *   controllers, and closes their underlying `WSContext` with
	 *   `WS_CLOSE_SESSION_REVOKED`
	 */
	close_sockets_for_session(token_hash: string): number {
		return this.#close_where((id) => id.token_hash === token_hash);
	}

	/**
	 * Close all sockets associated with a specific account, including a
	 * registration still pending admission.
	 *
	 * @returns the number of sockets closed
	 * @mutates this - removes matching connections, aborts their registered
	 *   controllers, and closes their underlying `WSContext` with
	 *   `WS_CLOSE_SESSION_REVOKED`
	 */
	close_sockets_for_account(account_id: Uuid): number {
		return this.#close_where((id) => id.account_id === account_id);
	}

	/**
	 * Close all sockets associated with a specific API token, including a
	 * registration still pending admission.
	 *
	 * Closes just this token's sockets, so revoking one token — or evicting
	 * one past the token cap — doesn't tear down the account's
	 * session-authenticated sockets or other tokens' sockets.
	 *
	 * @returns the number of sockets closed
	 * @mutates this - removes matching connections, aborts their registered
	 *   controllers, and closes their underlying `WSContext` with
	 *   `WS_CLOSE_SESSION_REVOKED`
	 */
	close_sockets_for_token(api_token_id: string): number {
		return this.#close_where((id) => id.api_token_id === api_token_id);
	}

	/**
	 * Close the sockets of `account_id` whose endpoint required `role`,
	 * including a registration still pending admission — the close for a
	 * revoked global grant of a role the upgrade gate admitted on. Each closes
	 * with `WS_CLOSE_PERMISSION_REVOKED`, not a revocation's code: the
	 * credential is still good.
	 *
	 * **Over-closes an any-of gate.** An endpoint gated on several roles admits
	 * an account holding any one of them, but this closes on the loss of any
	 * listed role, without checking whether the account still holds another.
	 * The client can reconnect when it still qualifies. The account's sockets
	 * on endpoints that did not list `role`, and on ungated ones, stay open.
	 *
	 * @returns the number of sockets closed
	 * @mutates this - removes matching connections, aborts their registered
	 *   controllers, and closes their underlying `WSContext` with
	 *   `WS_CLOSE_PERMISSION_REVOKED`
	 */
	close_sockets_for_role(account_id: Uuid, role: string): number {
		return this.#close_where(
			(id) => id.account_id === account_id && id.required_roles.includes(role),
			WS_CLOSE_PERMISSION_REVOKED,
			WS_CLOSE_PERMISSION_REVOKED_REASON
		);
	}

	/**
	 * Close every connection, pending or admitted, with `WS_CLOSE_GOING_AWAY` —
	 * the shutdown close `AppServer.close` runs. Not a revocation: the client
	 * reconnects under its ordinary backoff.
	 *
	 * Each closed connection is removed and its controller aborted, as a
	 * revocation does, so its heartbeat timer stops and nothing more dispatches
	 * on it. A socket whose `close` throws does not stop the loop.
	 *
	 * Leaves the transport closing, for good: every later registration is born
	 * closed (module doc, "Shutdown"). A second call closes nothing.
	 *
	 * @returns the number of sockets closed
	 * @mutates this - sets the transport closing, removes every connection,
	 *   aborts its registered controller, and closes its underlying `WSContext`
	 *   with `WS_CLOSE_GOING_AWAY`
	 * @throws the first error a socket's `close` threw, after every connection was attempted
	 */
	close_all_sockets(): number {
		// before any close, in the same synchronous step: an `admit` that finds
		// its entry gone reads the shutdown, never a revocation — and set even
		// when a socket's close throws
		this.#closing = true;
		return this.#close_where(() => true, WS_CLOSE_GOING_AWAY, WS_CLOSE_GOING_AWAY_REASON);
	}

	/**
	 * Whether `close_all_sockets` has run — the transport is shutting down and
	 * every registration from now on is born closed (module doc, "Shutdown").
	 * For telemetry and logs: `register_action_ws` reads it to say why an
	 * upgrade was refused.
	 */
	is_closing(): boolean {
		return this.#closing;
	}

	/**
	 * Close a registration that arrived after `close_all_sockets`, without
	 * inserting it. A socket whose `close` throws is logged, not thrown: the
	 * registration is refused either way, and its caller sees the aborted
	 * controller.
	 *
	 * @returns a fresh id that names no entry
	 */
	#close_born_closed(ws: WSContext, abort_controller: AbortController | null): Uuid {
		abort_controller?.abort();
		try {
			ws.close(WS_CLOSE_GOING_AWAY, WS_CLOSE_GOING_AWAY_REASON);
		} catch (error) {
			this.#log?.error('error closing a socket registered during shutdown:', error);
		}
		return create_uuid();
	}

	#cleanup_connection(connection_id: Uuid): void {
		this.#connections.delete(connection_id);
		// Wake any handler still awaiting a reply on this socket — the peer is
		// gone, so the request can never complete.
		this.#pending.drain(connection_id);
	}

	#end_connection(
		connection_id: Uuid,
		entry: ConnectionEntry,
		code: number,
		reason: string,
		backlog: WsOutboundBacklog = 'flush'
	): void {
		this.#cleanup_connection(connection_id);
		if (!entry.admitted) this.#pending_close_codes.set(connection_id, code);
		// abort before the close so a handler observing `ctx.signal` bails out
		// without waiting for the close handshake
		entry.abort_controller?.abort();
		this.#closing_writers.set(connection_id, entry.writer);
		entry.writer.close(code, reason, backlog, () => {
			this.#closing_writers.delete(connection_id);
		});
	}

	/**
	 * Hand one frame to a connection's writer. An overflow closes the
	 * connection before this returns (module doc, "Outbound bound").
	 *
	 * @param bytes - the frame's UTF-8 length, when the caller measured it once
	 *   for several recipients
	 * @returns whether the frame was accepted
	 */
	#deliver(connection_id: Uuid, entry: ConnectionEntry, frame: string, bytes?: number): boolean {
		const pushed = entry.writer.push(frame, bytes);
		if (pushed.kind === 'accepted') return true;
		if (pushed.kind === 'overflow') {
			this.#close_overflowed(connection_id, entry, pushed.overflow);
		}
		return false;
	}

	#close_overflowed(connection_id: Uuid, entry: ConnectionEntry, overflow: OutboundOverflow): void {
		// same line as the Rust spine's registry, so one grep finds either
		this.#log?.warn('ws: outbound queue overflow, closing the connection', {
			connection_id,
			account_id: entry.identity.account_id,
			...overflow
		});
		try {
			this.#end_connection(
				connection_id,
				entry,
				WS_CLOSE_OUTBOUND_OVERFLOW,
				WS_CLOSE_OUTBOUND_OVERFLOW_REASON,
				'discard'
			);
		} catch (error) {
			// the producer that overflowed this connection must not fail for it
			this.#log?.error('error closing overflowed client:', error);
		}
	}

	/**
	 * A connection's write deadline passed: remove it and abort its controller.
	 * Its writer has discarded what was waiting and cuts the socket next.
	 */
	#drop_stalled(connection_id: Uuid, stall: WsOutboundStall): void {
		const entry = this.#connections.get(connection_id);
		if (!entry) return;
		this.#cleanup_connection(connection_id);
		this.#log?.warn('ws: write stalled, dropping the connection', {
			connection_id,
			account_id: entry.identity.account_id,
			...stall
		});
		entry.abort_controller?.abort();
	}

	/**
	 * Make room for one more admitted connection on `account_id`: when the
	 * account already holds `max`, close its oldest so that `max - 1` remain.
	 * Pending registrations are neither counted nor closed — a connection that
	 * may yet be refused must not cost a live one its slot.
	 */
	#evict_oldest_for_account(account_id: Uuid, max: number): void {
		// Map iteration is insertion order, so `owned` is oldest-first
		const owned: Array<[Uuid, ConnectionEntry]> = [];
		for (const [connection_id, entry] of this.#connections) {
			if (entry.admitted && entry.identity.account_id === account_id) {
				owned.push([connection_id, entry]);
			}
		}
		const excess = owned.length + 1 - max;
		if (excess <= 0) return;
		for (let i = 0; i < excess; i++) {
			const [connection_id, entry] = owned[i]!;
			this.#supersede_connection(connection_id, entry);
		}
		// same line as the Rust spine's registry, so one grep finds either
		this.#log?.info('ws: connection cap closed oldest', { account_id, closed: excess, max });
	}

	#supersede_connection(connection_id: Uuid, entry: ConnectionEntry): void {
		try {
			this.#end_connection(connection_id, entry, WS_CLOSE_CONNECTION_LIMIT, 'connection limit');
		} catch (error) {
			// the evicted socket is another connection's — a failure closing it
			// must not fail the connection being admitted
			this.#log?.error('error closing superseded client:', error);
		}
	}

	/**
	 * Broadcast a notification to every admitted connection — a registration
	 * pending admission is not a connection yet. A server→client *request* has
	 * no single target here; that is `request_connection`.
	 *
	 * A connection the message overflows is closed and not counted (module doc,
	 * "Outbound bound").
	 *
	 * @returns the number of connections that accepted the message
	 */
	broadcast(message: JsonrpcNotification): number {
		const serialized = JSON.stringify(message);
		// measured once, not once per recipient that has to queue it
		const bytes = utf8_length(serialized);
		let count = 0;
		// deleting the current entry during Map iteration is safe — an overflow
		// removes its connection
		for (const [connection_id, entry] of this.#connections) {
			if (!entry.admitted) continue;
			if (this.#deliver(connection_id, entry, serialized, bytes)) count++;
		}
		return count;
	}

	/**
	 * Broadcast to admitted connections whose identity satisfies a predicate. A
	 * registration pending admission is skipped before the predicate runs.
	 *
	 * Used by the broadcast API when a consumer supplies a subscription ACL hook
	 * (e.g. an event that only reaches the account that owns the resource it reports).
	 * When no ACL is needed, callers should prefer `broadcast` to skip the
	 * per-connection predicate overhead.
	 *
	 * A connection the message overflows is closed and not counted (module doc,
	 * "Outbound bound").
	 *
	 * @returns the number of connections that accepted the message
	 */
	broadcast_filtered(
		message: JsonrpcMessageFromServerToClient,
		predicate: (identity: ConnectionIdentity) => boolean
	): number {
		const serialized = JSON.stringify(message);
		// measured once, not once per recipient that has to queue it
		const bytes = utf8_length(serialized);
		let count = 0;
		for (const [connection_id, entry] of this.#connections) {
			if (!entry.admitted || !predicate(entry.identity)) continue;
			if (this.#deliver(connection_id, entry, serialized, bytes)) count++;
		}
		return count;
	}

	/**
	 * Send a message to every admitted socket bound to a specific account.
	 *
	 * Targeted per-account fan-out for any flow where the delivery target
	 * is a single known account. Prefer this over `broadcast_filtered` when
	 * the filter is exactly "this account_id"; reach for `broadcast_filtered`
	 * when the ACL is an arbitrary predicate over `ConnectionIdentity`.
	 *
	 * Mirrors `close_sockets_for_account` on the send side: every connection
	 * for the account (session, bearer, and daemon-token) receives the
	 * message.
	 *
	 * @returns the number of connections that accepted the message
	 */
	send_to_account(account_id: Uuid, message: JsonrpcMessageFromServerToClient): number {
		return this.broadcast_filtered(message, (id) => id.account_id === account_id);
	}

	/**
	 * Send one serialized frame to a single admitted connection — the path
	 * `register_action_ws` sends every response, error frame, and socket-scoped
	 * notification through.
	 *
	 * Never waits and never throws. A frame the connection's outbound budget
	 * does not fit closes the connection with `WS_CLOSE_OUTBOUND_OVERFLOW` before
	 * this returns (module doc, "Outbound bound").
	 *
	 * @param connection_id - the id `register_pending` / `add_connection` returned
	 * @param frame - the frame's text, already serialized
	 * @returns `false` when the frame was not accepted: the connection is not
	 *   registered, is still pending admission, or was just closed for the
	 *   overflow this frame caused
	 * @mutates this - queues the frame on the connection's writer; on an
	 *   overflow removes the connection, aborts its controller, and closes its
	 *   `WSContext`
	 */
	send_to(connection_id: Uuid, frame: string): boolean {
		const entry = this.#connections.get(connection_id);
		if (!entry?.admitted) return false;
		return this.#deliver(connection_id, entry, frame);
	}

	/**
	 * Initiate a JSON-RPC request to a single connected client and await its
	 * reply — the server→client request/response direction (ActionPeer).
	 *
	 * Sends `{jsonrpc, method, params, id}` to exactly the `connection_id`
	 * socket (never a broadcast) and registers a pending entry scoped to that
	 * connection. Resolves when the client's matching reply arrives (routed in
	 * via `resolve_peer_response`), the deadline elapses (`timeout`), the
	 * per-connection cap is hit (`too_many_in_flight`), or the socket closes
	 * (`connection_gone`). A connection still pending admission answers
	 * `connection_gone` like an unknown one. Never throws — every failure is a
	 * `PeerRequestError`.
	 *
	 * Delegates correlation to `#pending` (id allocation, deadline, cap, drain);
	 * this method owns only the socket lookup + the send. Server-issued ids are
	 * `s`-prefixed so a malicious client echoing a non-`s` id (or an id it chose
	 * for its own request) matches nothing.
	 *
	 * @returns the client's success `result`, or a `PeerRequestError`
	 * @mutates this - registers then clears an entry in `#pending`
	 */
	request_connection(
		connection_id: Uuid,
		method: string,
		params: JsonrpcRequestParams | undefined,
		options?: PeerRequestOptions
	): Promise<PeerRequestOutcome> {
		const entry = this.#connections.get(connection_id);
		if (!entry?.admitted) {
			return Promise.resolve({ ok: false, error: { kind: 'connection_gone' } });
		}

		const registered = this.#pending.register(connection_id, options?.timeout_ms);
		if (!registered) return Promise.resolve({ ok: false, error: { kind: 'too_many_in_flight' } });
		const { id, outcome } = registered;

		let frame: string;
		try {
			frame = JSON.stringify(create_jsonrpc_request(method, params, id));
		} catch {
			// params that are not JSON reach no client
			this.#pending.settle(connection_id, id, { ok: false, error: { kind: 'connection_gone' } });
			return outcome;
		}
		if (!this.#deliver(connection_id, entry, frame)) {
			// Not accepted — the socket refused it, or the frame overflowed the
			// connection and closed it; settle now so the caller isn't left
			// awaiting until the deadline.
			this.#pending.settle(connection_id, id, { ok: false, error: { kind: 'connection_gone' } });
		}
		return outcome;
	}

	/**
	 * Route an inbound client reply to the matching pending server→client
	 * request on `connection_id` (delegates to `#pending.resolve`).
	 *
	 * Returns `false` when no entry matches — an unsolicited, cross-connection,
	 * or already-settled reply — so the caller drops it. Per-connection scoping
	 * means a reply arriving on the wrong socket resolves nothing.
	 *
	 * @returns whether a pending request was resolved
	 * @mutates this - clears the matched entry from `#pending`
	 */
	resolve_peer_response(
		connection_id: Uuid,
		response: JsonrpcResponse | JsonrpcErrorResponse
	): boolean {
		return this.#pending.resolve(connection_id, response);
	}

	/**
	 * Whether a connection is still registered — and admitted: a registration
	 * pending admission answers `false`, like every other reader of the
	 * transport.
	 *
	 * `register_action_ws` checks it before dispatching each inbound message, so
	 * a socket the server has closed — revoked, superseded by the cap, or
	 * refused at admission — dispatches nothing more while its close handshake
	 * is still in flight. The twin of the Rust `ConnectionRegistry::is_registered`.
	 */
	is_registered(connection_id: Uuid): boolean {
		return this.#connections.get(connection_id)?.admitted === true;
	}

	/**
	 * Number of currently **admitted** WebSocket connections.
	 *
	 * Read-only counter intended for telemetry, logging, and tests. A
	 * registration still pending admission is not a connection yet and is
	 * counted by `get_pending_connection_count` instead. Includes connections
	 * that have been closed by the peer but not yet removed by the WS adapter's
	 * `onClose` callback.
	 */
	get_connection_count(): number {
		let count = 0;
		for (const entry of this.#connections.values()) {
			if (entry.admitted) count++;
		}
		return count;
	}

	/**
	 * Number of registrations awaiting admission — between `register_pending`
	 * and `admit` (or their refusal). Each lives for one credential re-check, so
	 * a count that stays high means upgrades are stalling there. For telemetry
	 * and tests.
	 */
	get_pending_connection_count(): number {
		let count = 0;
		for (const entry of this.#connections.values()) {
			if (!entry.admitted) count++;
		}
		return count;
	}
}
