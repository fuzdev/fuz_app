/**
 * Tests for `register_action_ws` admission — the credential re-read between
 * the handshake and the connection's admission.
 *
 * The auth middleware resolves the credential before the upgrade, and the
 * socket exists only once `onOpen` fires; a revocation landing in between
 * closes every *registered* socket and so misses the one still upgrading.
 * `onOpen` therefore registers the connection pending, re-reads the
 * credential, and only then admits it.
 *
 * Each case drives `onOpen` against a real database, with real session and
 * token rows and no test-preset context, and holds the upgrade **at the
 * re-read** (`create_gated_db`) so something can happen in the window: a
 * revocation's write, a revocation's close, a frame from the client. The
 * control cases stall the same way and touch nothing, so a refusal is the
 * revocation's doing, not the stall's.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { Hono, type Context } from 'hono';
import type { WSEvents } from 'hono/ws';
import { z } from 'zod';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import {
	MAX_PRE_ADMISSION_FRAMES,
	register_action_ws,
	WS_CLOSE_PRE_ADMISSION_OVERFLOW_REASON,
	type SocketCloseContext,
	type SocketOpenContext
} from '$lib/actions/register_action_ws.ts';
import type { RequestResponseActionSpec } from '$lib/actions/action_spec.ts';
import { BackendWebsocketTransport } from '$lib/actions/transports_ws_backend.ts';
import {
	WS_CLOSE_CONNECTION_LIMIT,
	WS_CLOSE_INTERNAL_ERROR,
	WS_CLOSE_MESSAGE_TOO_BIG,
	WS_CLOSE_POLICY_VIOLATION,
	WS_CLOSE_SESSION_REVOKED,
	WS_CLOSE_SESSION_REVOKED_REASON
} from '$lib/actions/transports.ts';
import {
	query_account_soft_delete,
	query_create_account_with_actor
} from '$lib/auth/account_queries.ts';
import { generate_api_token } from '$lib/auth/api_token.ts';
import {
	query_create_api_token,
	query_revoke_all_api_tokens_for_account,
	query_revoke_api_token_for_account
} from '$lib/auth/api_token_queries.ts';
import {
	AUTH_SESSION_TOKEN_HASH_KEY,
	build_account_context,
	create_request_context_middleware,
	REQUEST_CONTEXT_KEY
} from '$lib/auth/request_context.ts';
import {
	generate_session_token,
	hash_session_token,
	query_create_session,
	query_session_revoke_all_for_account,
	query_session_revoke_for_account
} from '$lib/auth/session_queries.ts';
import { token_scope_full } from '$lib/auth/token_scope.ts';
import type { Db } from '$lib/db/db.ts';
import {
	ACCOUNT_ID_KEY,
	AUTH_API_TOKEN_ID_KEY,
	CREDENTIAL_TYPE_KEY,
	TOKEN_SCOPE_KEY
} from '$lib/hono_context.ts';
import type { JsonrpcNotification } from '$lib/http/jsonrpc.ts';
import { create_fake_ws, create_stub_upgrade, type FakeWs } from '$lib/testing/ws_round_trip.ts';

import { describe_db } from '../db_fixture.ts';
import {
	create_gated_db,
	is_api_token_live_read,
	is_session_read,
	type GatedDb,
	type StalledQuery
} from '../gated_db.ts';

const log = new Logger('test', { level: 'off' });

const REVOKED_CLOSE = { code: WS_CLOSE_SESSION_REVOKED, reason: WS_CLOSE_SESSION_REVOKED_REASON };

const echo_spec: RequestResponseActionSpec = {
	method: 'echo',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: false,
	input: z.strictObject({ value: z.string() }),
	output: z.strictObject({ value: z.string() }),
	async: true,
	description: 'echo'
};

/**
 * `echo` without the account gate. Dispatching it reads nothing from the
 * database, so its handler runs in the order its frames were dispatched —
 * which is what the ordering cases assert. (`echo` resolves its account per
 * message, and concurrent dispatches may finish that read in any order.)
 */
const mark_spec: RequestResponseActionSpec = {
	...echo_spec,
	method: 'mark',
	auth: { account: 'none', actor: 'none' },
	description: 'mark'
};

const notification: JsonrpcNotification = {
	jsonrpc: '2.0',
	method: 'thing_changed',
	params: { id: 'x' }
};

let account_counter = 0;

const create_account = async (db: Db): Promise<Uuid> => {
	const { account } = await query_create_account_with_actor(
		{ db },
		{ username: `ws_admission_${account_counter++}`, password_hash: 'hash' }
	);
	return account.id;
};

/** A session row on `account_id`: the raw token the cookie carries, and its hash. */
const create_session = async (
	db: Db,
	account_id: string
): Promise<{ session_token: string; token_hash: string }> => {
	const session_token = generate_session_token();
	const token_hash = hash_session_token(session_token);
	await query_create_session({ db }, token_hash, account_id, new Date(Date.now() + 3_600_000));
	return { session_token, token_hash };
};

/** A fake Hono `Context` over a plain variable bag — only `get` / `set`. */
const create_context = (vars: Record<string, unknown> = {}): Context =>
	({
		get: (key: string) => vars[key],
		set: (key: string, value: unknown) => {
			vars[key] = value;
		}
	}) as unknown as Context;

/**
 * The Hono context the upgrade sees after the production auth middleware ran,
 * with the account-grain `RequestContext` the upgrade's authorization phase
 * builds. No `TEST_CONTEXT_PRESET_KEY` — admission and dispatch both run live.
 *
 * A session credential is resolved by the real
 * `create_request_context_middleware`, from the raw token under
 * `session_context_key` — so the keys the upgrade reads are the ones
 * production sets. A bearer credential's keys are set the way the bearer
 * middleware sets them.
 */
const create_upgrade_context = async (
	db: Db,
	account_id: string,
	credential: { session_token: string } | { api_token_id: string },
	session_context_key = 'auth_session_id'
): Promise<Context> => {
	const vars: Record<string, unknown> = {};
	const c = create_context(vars);
	if ('session_token' in credential) {
		// what the session middleware leaves for the request-context middleware
		vars[session_context_key] = credential.session_token;
		await create_request_context_middleware({ db }, session_context_key)(c, async () => {});
		assert.strictEqual(vars[ACCOUNT_ID_KEY], account_id, 'the session resolved');
	} else {
		vars[ACCOUNT_ID_KEY] = account_id;
		vars[CREDENTIAL_TYPE_KEY] = 'api_token';
		vars[TOKEN_SCOPE_KEY] = token_scope_full();
		vars[AUTH_SESSION_TOKEN_HASH_KEY] = null;
		vars[AUTH_API_TOKEN_ID_KEY] = credential.api_token_id;
	}
	const request_context = await build_account_context({ db }, account_id);
	assert.ok(request_context);
	vars[REQUEST_CONTEXT_KEY] = request_context;
	return c;
};

interface Endpoint {
	gated: GatedDb;
	transport: BackendWebsocketTransport;
	/** Values the `echo` and `mark` handlers ran with, in the order they ran. */
	handled: Array<string>;
	opened: Array<SocketOpenContext>;
	closed: Array<SocketCloseContext>;
	create_events: (c: Context) => Promise<WSEvents>;
}

const create_endpoint = (
	db: Db,
	options: {
		max_connections_per_account?: number | null;
		on_socket_open?: (ctx: SocketOpenContext) => void | Promise<void>;
		max_message_bytes?: number;
	} = {}
): Endpoint => {
	const gated = create_gated_db(db);
	const stub = create_stub_upgrade();
	const handled: Array<string> = [];
	const opened: Array<SocketOpenContext> = [];
	const closed: Array<SocketCloseContext> = [];
	const { transport } = register_action_ws({
		path: '/ws',
		app: new Hono(),
		upgradeWebSocket: stub.upgradeWebSocket,
		actions: [echo_spec, mark_spec].map((spec) => ({
			spec,
			handler: (input: unknown) => {
				handled.push((input as { value: string }).value);
				return input;
			}
		})),
		db: gated.db,
		max_connections_per_account: options.max_connections_per_account,
		max_message_bytes: options.max_message_bytes,
		on_socket_open: async (ctx) => {
			opened.push(ctx);
			await options.on_socket_open?.(ctx);
		},
		on_socket_close: (ctx) => {
			closed.push(ctx);
		},
		heartbeat: false,
		log
	});
	return {
		gated,
		transport,
		handled,
		opened,
		closed,
		create_events: async (c) => stub.get_create_events()(c)
	};
};

interface Socket {
	fake: FakeWs;
	/** Settles when `onOpen` has run to its end — admitted or refused. */
	opening: Promise<void>;
	/** Deliver one inbound frame; resolves once it was dispatched or dropped. */
	send: (message: unknown) => Promise<void>;
	/** Fire the adapter's close event. */
	close: () => Promise<void>;
}

/** Fire `onOpen` for a fresh socket, without waiting for it. */
const open_socket = async (endpoint: Endpoint, c: Context): Promise<Socket> => {
	const events = await endpoint.create_events(c);
	const fake = create_fake_ws();
	const opening = Promise.resolve(events.onOpen?.(new Event('open'), fake.ws));
	return {
		fake,
		opening,
		send: (message) =>
			Promise.resolve(
				events.onMessage?.(
					new MessageEvent('message', {
						data: typeof message === 'string' ? message : JSON.stringify(message)
					}),
					fake.ws
				)
			),
		close: () => Promise.resolve(events.onClose?.(new CloseEvent('close'), fake.ws))
	};
};

/** Open a socket and hold its upgrade at the admission re-read. */
const open_stalled = async (
	endpoint: Endpoint,
	c: Context,
	match: (sql: string) => boolean = is_session_read
): Promise<{ socket: Socket; stalled: StalledQuery }> => {
	const stalled = endpoint.gated.stall(match);
	const socket = await open_socket(endpoint, c);
	await stalled.reached;
	assert.strictEqual(
		endpoint.transport.get_pending_connection_count(),
		1,
		'the connection is registered pending before the re-read'
	);
	return { socket, stalled };
};

const echo_request = (id: number, value: string): unknown => ({
	jsonrpc: '2.0',
	id,
	method: 'echo',
	params: { value }
});

const mark_request = (id: number, value: string): unknown => ({
	jsonrpc: '2.0',
	id,
	method: 'mark',
	params: { value }
});

const parse_frames = (fake: FakeWs): Array<Record<string, unknown>> =>
	fake.sends.map((frame) => JSON.parse(frame));

describe_db('register_action_ws admission', (get_db) => {
	describe('the credential re-read', () => {
		test('a stalled upgrade no revocation touches is admitted', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const session = await create_session(db, account_id);
			const endpoint = create_endpoint(db);
			const c = await create_upgrade_context(db, account_id, session);

			const { socket, stalled } = await open_stalled(endpoint, c);
			assert.strictEqual(endpoint.transport.get_connection_count(), 0, 'not admitted yet');
			assert.deepStrictEqual(endpoint.opened, [], 'on_socket_open waits for admission');

			stalled.release();
			await socket.opening;

			assert.deepStrictEqual(socket.fake.closes, []);
			assert.strictEqual(endpoint.transport.get_connection_count(), 1);
			assert.strictEqual(endpoint.transport.get_pending_connection_count(), 0);
			assert.strictEqual(endpoint.opened.length, 1);
			assert.strictEqual(endpoint.opened[0]!.signal.aborted, false);

			await socket.send(echo_request(1, 'hi'));
			assert.deepStrictEqual(parse_frames(socket.fake), [
				{ jsonrpc: '2.0', id: 1, result: { value: 'hi' } }
			]);
		});

		test('a session revoked during the upgrade is closed with 4001 — the re-read alone', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const session = await create_session(db, account_id);
			const endpoint = create_endpoint(db);
			const c = await create_upgrade_context(db, account_id, session);

			const { socket, stalled } = await open_stalled(endpoint, c);
			// the row goes and *no* close is delivered — the shape of a revocation
			// whose close ran before the connection registered and found nothing
			assert.ok(await query_session_revoke_for_account({ db }, session.token_hash, account_id));
			stalled.release();
			await socket.opening;

			assert.deepStrictEqual(socket.fake.closes, [REVOKED_CLOSE]);
			assert.deepStrictEqual(socket.fake.sends, [], 'nothing is written to a refused socket');
			assert.strictEqual(endpoint.transport.get_connection_count(), 0);
			assert.strictEqual(endpoint.transport.get_pending_connection_count(), 0);
			assert.deepStrictEqual(endpoint.opened, [], 'a refused socket runs no on_socket_open');

			// a client that withholds its close frame gets nothing dispatched
			await socket.send(echo_request(1, 'after refusal'));
			assert.deepStrictEqual(endpoint.handled, []);
			assert.deepStrictEqual(socket.fake.sends, []);

			await socket.close();
			assert.deepStrictEqual(endpoint.closed, [], 'and no on_socket_close');
		});

		test('an api token revoked during the upgrade is closed with 4001', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const { id, token_hash } = generate_api_token();
			await query_create_api_token({ db }, id, account_id, 'ws', token_hash, token_scope_full());
			const endpoint = create_endpoint(db);
			const c = await create_upgrade_context(db, account_id, { api_token_id: id });

			const { socket, stalled } = await open_stalled(endpoint, c, is_api_token_live_read);
			assert.ok(await query_revoke_api_token_for_account({ db }, id, account_id));
			stalled.release();
			await socket.opening;

			assert.deepStrictEqual(socket.fake.closes, [REVOKED_CLOSE]);
			assert.strictEqual(endpoint.transport.get_connection_count(), 0);
			assert.strictEqual(endpoint.transport.get_pending_connection_count(), 0);
		});

		test('a live api token is admitted', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const { id, token_hash } = generate_api_token();
			await query_create_api_token({ db }, id, account_id, 'ws', token_hash, token_scope_full());
			const endpoint = create_endpoint(db);
			const c = await create_upgrade_context(db, account_id, { api_token_id: id });

			const { socket, stalled } = await open_stalled(endpoint, c, is_api_token_live_read);
			stalled.release();
			await socket.opening;

			assert.deepStrictEqual(socket.fake.closes, []);
			assert.strictEqual(endpoint.transport.get_connection_count(), 1);
		});

		test('a password change during the upgrade refuses sessions and tokens', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const session = await create_session(db, account_id);
			const { id, token_hash } = generate_api_token();
			await query_create_api_token({ db }, id, account_id, 'ws', token_hash, token_scope_full());
			const endpoint = create_endpoint(db);

			const by_session = await open_stalled(
				endpoint,
				await create_upgrade_context(db, account_id, session)
			);
			// what `/password` does once the new hash is stored
			await query_session_revoke_all_for_account({ db }, account_id);
			await query_revoke_all_api_tokens_for_account({ db }, account_id);
			by_session.stalled.release();
			await by_session.socket.opening;
			assert.deepStrictEqual(by_session.socket.fake.closes, [REVOKED_CLOSE]);

			// a bearer upgrade resolved before the change is refused the same way
			const by_token = await open_socket(
				endpoint,
				await create_upgrade_context(db, account_id, { api_token_id: id })
			);
			await by_token.opening;
			assert.deepStrictEqual(by_token.fake.closes, [REVOKED_CLOSE]);
			assert.strictEqual(endpoint.transport.get_connection_count(), 0);
		});

		test('an account soft-deleted during the upgrade is closed with 4001', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const session = await create_session(db, account_id);
			const endpoint = create_endpoint(db);
			const c = await create_upgrade_context(db, account_id, session);

			const { socket, stalled } = await open_stalled(endpoint, c);
			// the tombstone alone — the session row is still there
			assert.ok(await query_account_soft_delete({ db }, account_id, null));
			stalled.release();
			await socket.opening;

			assert.deepStrictEqual(socket.fake.closes, [REVOKED_CLOSE]);
			assert.strictEqual(endpoint.transport.get_connection_count(), 0);
		});

		test("another session's revocation still admits", async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const session = await create_session(db, account_id);
			const other = await create_session(db, account_id);
			const endpoint = create_endpoint(db);
			const c = await create_upgrade_context(db, account_id, session);

			const { socket, stalled } = await open_stalled(endpoint, c);
			assert.ok(await query_session_revoke_for_account({ db }, other.token_hash, account_id));
			assert.strictEqual(endpoint.transport.close_sockets_for_session(other.token_hash), 0);
			stalled.release();
			await socket.opening;

			assert.deepStrictEqual(socket.fake.closes, []);
			assert.strictEqual(endpoint.transport.get_connection_count(), 1);
		});

		test('a failing re-check closes the socket with 1011 — never admitted unchecked', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const session = await create_session(db, account_id);
			const endpoint = create_endpoint(db);
			const c = await create_upgrade_context(db, account_id, session);

			const { socket, stalled } = await open_stalled(endpoint, c);
			const queued = socket.send(echo_request(1, 'queued'));
			stalled.fail(new Error('connection lost'));
			await socket.opening;
			await queued;

			assert.deepStrictEqual(socket.fake.closes, [
				{ code: WS_CLOSE_INTERNAL_ERROR, reason: 'internal error' }
			]);
			assert.deepStrictEqual(socket.fake.sends, []);
			assert.deepStrictEqual(endpoint.handled, []);
			assert.strictEqual(endpoint.transport.get_connection_count(), 0);
			assert.strictEqual(endpoint.transport.get_pending_connection_count(), 0);
			assert.deepStrictEqual(endpoint.opened, []);
		});
	});

	describe('the credential the upgrade resolves', () => {
		test('a session under a custom session context key is admitted, and closeable by its hash', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const session = await create_session(db, account_id);
			const endpoint = create_endpoint(db);
			// the request-context middleware was mounted with its own key, so
			// nothing sits under the default `auth_session_id`
			const c = await create_upgrade_context(db, account_id, session, 'custom_session');
			assert.strictEqual(c.get('auth_session_id' as never), undefined);

			const socket = await open_socket(endpoint, c);
			await socket.opening;

			assert.deepStrictEqual(socket.fake.closes, []);
			assert.strictEqual(endpoint.transport.get_connection_count(), 1);
			assert.strictEqual(
				endpoint.opened[0]!.identity.token_hash,
				session.token_hash,
				'registered under the hash the middleware resolved'
			);
			assert.strictEqual(endpoint.transport.close_sockets_for_session(session.token_hash), 1);
			assert.deepStrictEqual(socket.fake.closes, [REVOKED_CLOSE]);
		});

		test('a session credential with no token hash on the context is refused', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const session = await create_session(db, account_id);
			const endpoint = create_endpoint(db);
			// a live session, but a context that carries only the raw token — a
			// shape the middleware never builds, so nothing is derived from it
			const c = create_context({
				[ACCOUNT_ID_KEY]: account_id,
				[CREDENTIAL_TYPE_KEY]: 'session',
				[TOKEN_SCOPE_KEY]: token_scope_full(),
				auth_session_id: session.session_token,
				[REQUEST_CONTEXT_KEY]: await build_account_context({ db }, account_id)
			});

			const socket = await open_socket(endpoint, c);
			await socket.opening;

			assert.deepStrictEqual(socket.fake.closes, [REVOKED_CLOSE]);
			assert.strictEqual(endpoint.transport.get_connection_count(), 0);
			assert.deepStrictEqual(endpoint.opened, []);
		});

		test('an upgrade with no resolved credential throws before the socket exists', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const endpoint = create_endpoint(db);
			const c = create_context({
				[REQUEST_CONTEXT_KEY]: await build_account_context({ db }, account_id)
			});

			await assert_rejects(() => endpoint.create_events(c), /no resolved credential/);
			assert.strictEqual(endpoint.transport.get_pending_connection_count(), 0);
		});

		test('a credential on another account than the request context throws before the socket exists', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const other_account_id = await create_account(db);
			const session = await create_session(db, other_account_id);
			const endpoint = create_endpoint(db);
			// the credential resolves to one account, the request context names another
			const c = await create_upgrade_context(db, other_account_id, session);
			c.set(
				REQUEST_CONTEXT_KEY as never,
				(await build_account_context({ db }, account_id)) as never
			);

			await assert_rejects(() => endpoint.create_events(c), /name different accounts/);
			assert.strictEqual(endpoint.transport.get_pending_connection_count(), 0);
		});
	});

	describe('a close during the upgrade', () => {
		test('a revocation close reaches the pending connection, which is then refused', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const session = await create_session(db, account_id);
			const endpoint = create_endpoint(db);
			const c = await create_upgrade_context(db, account_id, session);

			const { socket, stalled } = await open_stalled(endpoint, c);
			// the close finds the pending registration while the session row is
			// still there — an account-wide close from another session's logout
			// does exactly this. The re-read passes, so only admission can refuse.
			assert.strictEqual(endpoint.transport.close_sockets_for_account(account_id), 1);
			assert.deepStrictEqual(socket.fake.closes, [REVOKED_CLOSE], 'closed at once');
			stalled.release();
			await socket.opening;

			assert.deepStrictEqual(socket.fake.closes, [REVOKED_CLOSE], 'one close frame, not two');
			assert.strictEqual(endpoint.transport.get_connection_count(), 0);
			assert.strictEqual(endpoint.transport.get_pending_connection_count(), 0);
			assert.deepStrictEqual(endpoint.opened, []);

			await socket.send(echo_request(1, 'after refusal'));
			assert.deepStrictEqual(endpoint.handled, []);
		});

		test('the client leaving during the upgrade admits nothing and sends no close', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const session = await create_session(db, account_id);
			const endpoint = create_endpoint(db);
			const c = await create_upgrade_context(db, account_id, session);

			const { socket, stalled } = await open_stalled(endpoint, c);
			await socket.close();
			assert.strictEqual(endpoint.transport.get_pending_connection_count(), 0);
			stalled.release();
			await socket.opening;

			assert.deepStrictEqual(socket.fake.closes, []);
			assert.strictEqual(endpoint.transport.get_connection_count(), 0);
			assert.deepStrictEqual(endpoint.opened, []);
			assert.deepStrictEqual(endpoint.closed, []);
		});
	});

	describe('the per-account cap', () => {
		test('a refused upgrade never evicts a live socket of the same account', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const live_session = await create_session(db, account_id);
			const revoked_session = await create_session(db, account_id);
			const endpoint = create_endpoint(db, { max_connections_per_account: 1 });

			const live = await open_socket(
				endpoint,
				await create_upgrade_context(db, account_id, live_session)
			);
			await live.opening;
			assert.strictEqual(endpoint.transport.get_connection_count(), 1);

			const { socket, stalled } = await open_stalled(
				endpoint,
				await create_upgrade_context(db, account_id, revoked_session)
			);
			assert.deepStrictEqual(live.fake.closes, [], 'a pending registration evicts nothing');
			assert.ok(
				await query_session_revoke_for_account({ db }, revoked_session.token_hash, account_id)
			);
			stalled.release();
			await socket.opening;

			assert.deepStrictEqual(socket.fake.closes, [REVOKED_CLOSE]);
			assert.deepStrictEqual(live.fake.closes, [], 'the live socket keeps its slot');
			assert.strictEqual(endpoint.transport.get_connection_count(), 1);
			await live.send(echo_request(1, 'still here'));
			assert.deepStrictEqual(endpoint.handled, ['still here']);
		});

		test('an admitted upgrade evicts the oldest at admission, not at registration', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const first_session = await create_session(db, account_id);
			const second_session = await create_session(db, account_id);
			const endpoint = create_endpoint(db, { max_connections_per_account: 1 });

			const first = await open_socket(
				endpoint,
				await create_upgrade_context(db, account_id, first_session)
			);
			await first.opening;

			const { socket, stalled } = await open_stalled(
				endpoint,
				await create_upgrade_context(db, account_id, second_session)
			);
			assert.deepStrictEqual(first.fake.closes, []);
			stalled.release();
			await socket.opening;

			assert.deepStrictEqual(first.fake.closes, [
				{ code: WS_CLOSE_CONNECTION_LIMIT, reason: 'connection limit' }
			]);
			assert.deepStrictEqual(socket.fake.closes, []);
			assert.strictEqual(endpoint.transport.get_connection_count(), 1);
		});
	});

	describe('frames sent before admission', () => {
		test('wait for admission, then dispatch in arrival order', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const session = await create_session(db, account_id);
			const endpoint = create_endpoint(db);
			const c = await create_upgrade_context(db, account_id, session);

			const { socket, stalled } = await open_stalled(endpoint, c);
			const sent = [
				socket.send(mark_request(1, 'first')),
				socket.send(mark_request(2, 'second')),
				socket.send(mark_request(3, 'third')),
				socket.send(echo_request(4, 'authenticated'))
			];
			// give a dispatch every chance to run on the unverified credential
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.deepStrictEqual(endpoint.handled, [], 'nothing dispatches before admission');
			assert.deepStrictEqual(socket.fake.sends, []);

			stalled.release();
			await socket.opening;
			await Promise.all(sent);

			// dispatched back to back in arrival order; the account-gated request
			// resolves its account first, so it lands after the three that don't
			assert.deepStrictEqual(endpoint.handled, ['first', 'second', 'third', 'authenticated']);
			assert.deepStrictEqual(
				parse_frames(socket.fake).map((frame) => frame.id),
				[1, 2, 3, 4]
			);
		});

		test('are dropped unread when the upgrade is refused', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const session = await create_session(db, account_id);
			const endpoint = create_endpoint(db);
			const c = await create_upgrade_context(db, account_id, session);

			const { socket, stalled } = await open_stalled(endpoint, c);
			const sent = [socket.send(echo_request(1, 'first')), socket.send(echo_request(2, 'second'))];
			assert.ok(await query_session_revoke_for_account({ db }, session.token_hash, account_id));
			stalled.release();
			await socket.opening;
			await Promise.all(sent);

			assert.deepStrictEqual(endpoint.handled, []);
			assert.deepStrictEqual(socket.fake.sends, []);
			assert.deepStrictEqual(socket.fake.closes, [REVOKED_CLOSE]);
		});

		test('are dropped when a revocation closes the pending connection', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const session = await create_session(db, account_id);
			const endpoint = create_endpoint(db);
			const c = await create_upgrade_context(db, account_id, session);

			const { socket, stalled } = await open_stalled(endpoint, c);
			const sent = socket.send(echo_request(1, 'first'));
			assert.strictEqual(endpoint.transport.close_sockets_for_session(session.token_hash), 1);
			// dropped at the close, without waiting for the re-read to return
			await sent;
			stalled.release();
			await socket.opening;

			assert.deepStrictEqual(endpoint.handled, []);
			assert.deepStrictEqual(socket.fake.sends, []);
		});

		test('wait for on_socket_open as well, which runs only once admitted', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const session = await create_session(db, account_id);
			const order: Array<string> = [];
			const hook = Promise.withResolvers<void>();
			const endpoint = create_endpoint(db, {
				on_socket_open: async (ctx) => {
					order.push(`hook:start admitted=${endpoint.transport.is_registered(ctx.connection_id)}`);
					await hook.promise;
					order.push('hook:end');
				}
			});
			const c = await create_upgrade_context(db, account_id, session);

			const { socket, stalled } = await open_stalled(endpoint, c);
			assert.deepStrictEqual(order, [], 'the hook does not run on a pending connection');
			stalled.release();
			// admitted, the hook now holds the open
			await new Promise((resolve) => setTimeout(resolve, 20));
			const sent = socket.send(echo_request(1, 'during hook'));
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.deepStrictEqual(endpoint.handled, []);

			hook.resolve();
			await socket.opening;
			await sent;

			assert.deepStrictEqual(order, ['hook:start admitted=true', 'hook:end']);
			assert.deepStrictEqual(endpoint.handled, ['during hook']);
		});

		test('one frame past MAX_PRE_ADMISSION_FRAMES closes the socket with 1008', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const session = await create_session(db, account_id);
			const endpoint = create_endpoint(db);
			const c = await create_upgrade_context(db, account_id, session);

			const { socket, stalled } = await open_stalled(endpoint, c);
			const sent: Array<Promise<void>> = [];
			for (let i = 0; i < MAX_PRE_ADMISSION_FRAMES; i++) {
				sent.push(socket.send(echo_request(i, `frame ${i}`)));
			}
			assert.deepStrictEqual(socket.fake.closes, [], 'the cap itself is admitted');

			sent.push(socket.send(echo_request(MAX_PRE_ADMISSION_FRAMES, 'one too many')));

			assert.deepStrictEqual(socket.fake.closes, [
				{ code: WS_CLOSE_POLICY_VIOLATION, reason: WS_CLOSE_PRE_ADMISSION_OVERFLOW_REASON }
			]);
			assert.strictEqual(endpoint.transport.get_pending_connection_count(), 0);
			stalled.release();
			await socket.opening;
			await Promise.all(sent);

			assert.deepStrictEqual(endpoint.handled, [], 'the queued frames are dropped with the socket');
			assert.strictEqual(endpoint.transport.get_connection_count(), 0);
		});

		test('an oversized frame closes the pending socket with 1009', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const session = await create_session(db, account_id);
			const endpoint = create_endpoint(db, { max_message_bytes: 64 });
			const c = await create_upgrade_context(db, account_id, session);

			const { socket, stalled } = await open_stalled(endpoint, c);
			await socket.send(echo_request(1, 'x'.repeat(100)));

			assert.deepStrictEqual(socket.fake.closes, [
				{ code: WS_CLOSE_MESSAGE_TOO_BIG, reason: 'message too big' }
			]);
			assert.strictEqual(endpoint.transport.get_pending_connection_count(), 0);
			stalled.release();
			await socket.opening;

			assert.strictEqual(endpoint.transport.get_connection_count(), 0);
			assert.deepStrictEqual(endpoint.handled, []);
		});
	});

	describe('a pending connection is inert', () => {
		test('no broadcast or account push reaches it, and none is replayed at admission', async () => {
			const db = get_db();
			const account_id = await create_account(db);
			const session = await create_session(db, account_id);
			const endpoint = create_endpoint(db);
			const c = await create_upgrade_context(db, account_id, session);

			const { socket, stalled } = await open_stalled(endpoint, c);
			await endpoint.transport.send(notification);
			assert.strictEqual(endpoint.transport.send_to_account(account_id, notification), 0);
			assert.deepStrictEqual(socket.fake.sends, []);

			stalled.release();
			await socket.opening;
			assert.deepStrictEqual(socket.fake.sends, [], 'nothing was queued for it while pending');

			assert.strictEqual(endpoint.transport.send_to_account(account_id, notification), 1);
			assert.deepStrictEqual(socket.fake.sends, [JSON.stringify(notification)]);
		});
	});
});
