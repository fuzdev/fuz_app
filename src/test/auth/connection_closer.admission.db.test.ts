/**
 * The interleaving a post-commit close exists for: a connection admitted while
 * a revocation's transaction is still open.
 *
 * Admission registers a connection, re-reads its credential, and admits it —
 * so a revocation that *committed* before the re-read is seen, and one whose
 * close ran after the registration finds the entry. What neither catches is a
 * close that ran before the registration for a revocation that commits after
 * the re-read: the close missed the connection, and the re-read saw the
 * credential still alive. That is every close fired before its own commit.
 *
 * Each case builds exactly that schedule, for every revocation site and both
 * transports:
 *
 * 1. the revoking request runs its handler and is held **just before its
 *    commit** (`create_gated_db`'s `hold_commit`) — the row is deleted, the
 *    delete uncommitted. The case then waits for the request's audit row to
 *    land: that write is pool-routed and eager, so it lands while the
 *    transaction is held, and anything that reacts to the *write* rather than
 *    the commit has reacted by now;
 * 2. a connection on the revoked credential opens. Its admission re-read goes
 *    through the pool, sees the row (the delete is invisible to it), and
 *    admits;
 * 3. the commit is released.
 *
 * The connection must be closed by the time the revoking request returns. A
 * close that ran inside step 1 — the handler's, or an audit listener's on the
 * written row — found nothing to close and leaves the connection open on a
 * dead credential for its lifetime.
 *
 * Real Postgres only: step 2 needs a second database connection reading
 * concurrently with an open transaction. PGlite has one connection — the
 * re-read would queue behind the held transaction and the case would
 * deadlock. Skipped when `TEST_DATABASE_URL` is unset.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { Hono, type Context } from 'hono';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';
import { wait } from '@fuzdev/fuz_util/async.ts';

import { heartbeat_action } from '$lib/actions/heartbeat.ts';
import { register_action_ws } from '$lib/actions/register_action_ws.ts';
import {
	WS_CLOSE_SESSION_REVOKED,
	WS_CLOSE_SESSION_REVOKED_REASON
} from '$lib/actions/transports.ts';
import { create_ws_auth_guard } from '$lib/actions/transports_ws_auth_guard.ts';
import type { BackendWebsocketTransport } from '$lib/actions/transports_ws_backend.ts';
import { create_account_route_specs } from '$lib/auth/account_routes.ts';
import { create_audit_log_route_specs } from '$lib/auth/audit_log_routes.ts';
import {
	AUTH_SESSION_TOKEN_HASH_KEY,
	build_account_context,
	REQUEST_CONTEXT_KEY
} from '$lib/auth/request_context.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from '$lib/auth/role_schema.ts';
import { create_session_config } from '$lib/auth/session_cookie.ts';
import { create_standard_rpc_actions } from '$lib/auth/standard_rpc_actions.ts';
import { token_scope_full } from '$lib/auth/token_scope.ts';
import type { Db } from '$lib/db/db.ts';
import {
	ACCOUNT_ID_KEY,
	AUTH_API_TOKEN_ID_KEY,
	CREDENTIAL_TYPE_KEY,
	TOKEN_SCOPE_KEY
} from '$lib/hono_context.ts';
import { prefix_route_specs } from '$lib/http/route_spec.ts';
import type { AuditLogSse } from '$lib/realtime/sse_auth_guard.ts';
import { require_audit_sse } from '$lib/server/app_server.ts';
import { create_test_app, type TestAccount, type TestApp } from '$lib/testing/app_server.ts';
import { install_audit_drift_guard } from '$lib/testing/audit_drift_guard.ts';
import { auth_integration_truncate_tables, create_describe_db } from '$lib/testing/db.ts';
import { rpc_call } from '$lib/testing/rpc_helpers.ts';
import { DEFAULT_TEST_PASSWORD } from '$lib/testing/test_credentials.ts';
import { create_fake_ws, create_stub_upgrade, type FakeWs } from '$lib/testing/ws_round_trip.ts';

import { pg_factory } from '../db_fixture.ts';
import { create_gated_db, type GatedDb } from '../gated_db.ts';

const log = new Logger('test', { level: 'off' });
const session_options = create_session_config('test_session');
const RPC_PATH = '/api/rpc';
const STREAM_PATH = '/api/admin/audit/stream';
const REVOKED_CLOSE = { code: WS_CLOSE_SESSION_REVOKED, reason: WS_CLOSE_SESSION_REVOKED_REASON };

const describe_pg = create_describe_db(pg_factory, auth_integration_truncate_tables);

/** The credential a victim connection opens on. */
type Credential = { session_token_hash: string } | { api_token_id: string };

/** One WebSocket endpoint over the harness's database, and how its sockets get closed. */
interface WsEndpoint {
	transport: BackendWebsocketTransport;
	/** Run the upgrade's `onOpen` for `credential`; resolves once admitted or refused. */
	open: (account_id: Uuid, credential: Credential) => Promise<FakeWs>;
}

interface Harness {
	test_app: TestApp;
	/** The raw pool — a write here is never held. */
	db: Db;
	gated: GatedDb;
	audit_sse: AuditLogSse;
	/** Its transport is in `deps.connection_closer`: the revocation handlers close it. */
	ws_closed_by_handlers: WsEndpoint;
	/**
	 * Its transport is *not* in the closer; only a `create_ws_auth_guard`
	 * listener reaches it — the wiring of a consumer that relies on the audit
	 * listeners alone.
	 */
	ws_closed_by_listener: WsEndpoint;
}

const create_ws_endpoint = (
	h: { test_app: TestApp; gated: GatedDb },
	closed_by: 'handlers' | 'listener'
): WsEndpoint => {
	const { deps } = h.test_app.backend;
	const stub = create_stub_upgrade();
	const { transport } = register_action_ws({
		action_ip_rate_limiter: null,
		action_account_rate_limiter: null,
		path: '/ws',
		app: new Hono(),
		upgradeWebSocket: stub.upgradeWebSocket,
		actions: [heartbeat_action],
		db: h.gated.db,
		connection_closer: closed_by === 'handlers' ? deps.connection_closer : null,
		heartbeat: false,
		log
	});
	if (closed_by === 'listener') deps.audit.add_listener(create_ws_auth_guard(transport, log));
	return {
		transport,
		open: async (account_id, credential) => {
			// what the auth middleware leaves on the context for the upgrade
			const vars: Record<string, unknown> = { [ACCOUNT_ID_KEY]: account_id };
			if ('session_token_hash' in credential) {
				vars[CREDENTIAL_TYPE_KEY] = 'session';
				vars[AUTH_SESSION_TOKEN_HASH_KEY] = credential.session_token_hash;
			} else {
				vars[CREDENTIAL_TYPE_KEY] = 'api_token';
				vars[TOKEN_SCOPE_KEY] = token_scope_full();
				vars[AUTH_SESSION_TOKEN_HASH_KEY] = null;
				vars[AUTH_API_TOKEN_ID_KEY] = credential.api_token_id;
			}
			const request_context = await build_account_context({ db: h.gated.db }, account_id);
			assert.ok(request_context);
			vars[REQUEST_CONTEXT_KEY] = request_context;
			const c = { get: (key: string) => vars[key] } as unknown as Context;
			const events = await stub.get_create_events()(c);
			const fake = create_fake_ws();
			// typed `void` by Hono, but `register_action_ws` returns the admission's promise
			await (events.onOpen?.(new Event('open'), fake.ws) as Promise<void> | void);
			return fake;
		}
	};
};

const create_harness = async (
	db: Db,
	options: { max_sessions?: number; max_tokens?: number } = {}
): Promise<Harness> => {
	const gated = create_gated_db(db);
	const test_app = await create_test_app({
		session_options,
		db: gated.db,
		db_type: 'postgres',
		roles: [ROLE_KEEPER, ROLE_ADMIN],
		app_options: { audit_log_sse: true },
		create_route_specs: (ctx) => [
			...prefix_route_specs(
				'/api/account',
				create_account_route_specs(ctx.deps, {
					session_options,
					login_ip_rate_limiter: null,
					login_account_rate_limiter: null,
					login_fail_floor_ms: 0,
					max_sessions: options.max_sessions
				})
			),
			...prefix_route_specs('/api/admin', create_audit_log_route_specs({ stream: ctx.audit_sse! }))
		],
		rpc_endpoints: (ctx) => [
			{
				path: RPC_PATH,
				actions: create_standard_rpc_actions(ctx.deps, { max_tokens: options.max_tokens })
			}
		]
	});
	const audit_sse = require_audit_sse(test_app.server);
	const base = { test_app, gated };
	return {
		...base,
		db,
		audit_sse,
		ws_closed_by_handlers: create_ws_endpoint(base, 'handlers'),
		ws_closed_by_listener: create_ws_endpoint(base, 'listener')
	};
};

const rpc = async (
	h: Harness,
	method: string,
	params: unknown,
	headers: Record<string, string>,
	suppress_default_origin = false
): Promise<boolean> =>
	(
		await rpc_call({
			app: h.test_app.app,
			path: RPC_PATH,
			method,
			params,
			headers,
			suppress_default_origin
		})
	).ok;

/** The one session `headers` authenticates — every account here has exactly one. */
const session_hash_of = async (h: Harness, headers: Record<string, string>): Promise<string> => {
	const res = await rpc_call({
		app: h.test_app.app,
		path: RPC_PATH,
		method: 'account_session_list',
		headers
	});
	assert.strictEqual(res.ok, true);
	const sessions = res.ok ? (res.result as { sessions: Array<{ id: string }> }).sessions : [];
	assert.strictEqual(sessions.length, 1);
	return sessions[0]!.id;
};

const token_id_of = async (h: Harness, account_id: Uuid): Promise<string> => {
	const rows = await h.db.query<{ id: string }>(`SELECT id FROM api_token WHERE account_id = $1`, [
		account_id
	]);
	assert.strictEqual(rows.length, 1);
	return rows[0]!.id;
};

const keeper_headers = (h: Harness): Record<string, string> => h.test_app.create_session_headers();

const login_headers = {
	host: 'localhost',
	origin: 'http://localhost:5173',
	'Content-Type': 'application/json'
};

/** A revocation, and the account whose credential it ends. */
interface Revocation {
	/** The audit event the revoking request writes on success. */
	event_type: string;
	/** The account whose credential the revocation ends. */
	account: { id: Uuid };
	/** Session headers of that account — its one session is the credential a stream opens on. */
	session_headers: Record<string, string>;
	/** Make the revoking request; resolves whether it succeeded. */
	act: () => Promise<boolean>;
}

interface Site {
	name: string;
	/** The audit event the site writes on success. */
	event_type: string;
	max_sessions?: number;
	max_tokens?: number;
	/** Which credential of the account the revocation ends. */
	revokes: 'session' | 'token';
	/** The revoked account must hold `admin` for its session to open the audit stream. */
	arrange: (h: Harness) => Promise<Omit<Revocation, 'event_type'>>;
}

const keeper_revocation = (
	h: Harness,
	act: () => Promise<boolean>
): Omit<Revocation, 'event_type'> => ({
	account: h.test_app.backend.account,
	session_headers: keeper_headers(h),
	act
});

/** A second admin, revoked by the keeper. */
const create_target = (h: Harness): Promise<TestAccount> =>
	h.test_app.create_account({ username: 'revoked_admin', roles: [ROLE_ADMIN] });

const sites: Array<Site> = [
	{
		name: 'account_session_revoke',
		event_type: 'session_revoke',
		revokes: 'session',
		arrange: async (h) => {
			const session_id = await session_hash_of(h, keeper_headers(h));
			return keeper_revocation(h, () =>
				rpc(h, 'account_session_revoke', { session_id }, keeper_headers(h))
			);
		}
	},
	{
		name: 'account_session_revoke_all',
		event_type: 'session_revoke_all',
		revokes: 'session',
		arrange: (h) =>
			Promise.resolve(
				keeper_revocation(h, () =>
					rpc(h, 'account_session_revoke_all', undefined, keeper_headers(h))
				)
			)
	},
	{
		name: 'account_token_revoke',
		event_type: 'token_revoke',
		revokes: 'token',
		arrange: async (h) => {
			const token_id = await token_id_of(h, h.test_app.backend.account.id);
			return keeper_revocation(h, () =>
				rpc(h, 'account_token_revoke', { token_id }, keeper_headers(h))
			);
		}
	},
	{
		name: 'account_token_create (cap eviction)',
		event_type: 'token_create',
		revokes: 'token',
		max_tokens: 1,
		arrange: (h) =>
			Promise.resolve(
				keeper_revocation(h, () =>
					rpc(
						h,
						'account_token_create',
						{ name: 'one past the cap', scope: { kind: 'full' }, lifetime: { kind: 'eternal' } },
						keeper_headers(h)
					)
				)
			)
	},
	{
		name: 'admin_session_revoke_all',
		event_type: 'session_revoke_all',
		revokes: 'session',
		arrange: async (h) => {
			const target = await create_target(h);
			return {
				account: target.account,
				session_headers: target.create_session_headers(),
				act: () =>
					rpc(h, 'admin_session_revoke_all', { account_id: target.account.id }, keeper_headers(h))
			};
		}
	},
	{
		name: 'admin_token_revoke_all',
		event_type: 'token_revoke_all',
		revokes: 'token',
		arrange: async (h) => {
			const target = await create_target(h);
			return {
				account: target.account,
				session_headers: target.create_session_headers(),
				act: () =>
					rpc(h, 'admin_token_revoke_all', { account_id: target.account.id }, keeper_headers(h))
			};
		}
	},
	{
		name: 'account_delete',
		event_type: 'account_delete',
		revokes: 'session',
		arrange: async (h) => {
			const target = await create_target(h);
			return {
				account: target.account,
				session_headers: target.create_session_headers(),
				act: () => rpc(h, 'account_delete', { account_id: target.account.id }, keeper_headers(h))
			};
		}
	},
	{
		name: 'account_purge',
		event_type: 'account_purge',
		revokes: 'session',
		arrange: async (h) => {
			const target = await create_target(h);
			return {
				account: target.account,
				session_headers: target.create_session_headers(),
				// purge is gated to the daemon-token credential, which the
				// middleware discards beside an `Origin` header
				act: () =>
					rpc(
						h,
						'account_purge',
						{ account_id: target.account.id, confirm: true },
						h.test_app.create_daemon_token_headers(),
						true
					)
			};
		}
	},
	{
		name: 'POST /logout',
		event_type: 'logout',
		revokes: 'session',
		arrange: (h) =>
			Promise.resolve(
				keeper_revocation(
					h,
					async () =>
						(
							await h.test_app.app.request('/api/account/logout', {
								method: 'POST',
								headers: keeper_headers(h),
								body: null
							})
						).ok
				)
			)
	},
	{
		name: 'POST /password',
		event_type: 'password_change',
		revokes: 'session',
		arrange: (h) =>
			Promise.resolve(
				keeper_revocation(
					h,
					async () =>
						(
							await h.test_app.app.request('/api/account/password', {
								method: 'POST',
								headers: { ...keeper_headers(h), 'Content-Type': 'application/json' },
								body: JSON.stringify({
									current_password: DEFAULT_TEST_PASSWORD,
									new_password: 'new-test-password-xyz'
								})
							})
						).ok
				)
			)
	},
	{
		name: 'POST /login (cap eviction)',
		event_type: 'login',
		revokes: 'session',
		max_sessions: 1,
		arrange: (h) =>
			Promise.resolve(
				keeper_revocation(
					h,
					async () =>
						(
							await h.test_app.app.request('/api/account/login', {
								method: 'POST',
								headers: login_headers,
								body: JSON.stringify({ username: 'keeper', password: DEFAULT_TEST_PASSWORD })
							})
						).ok
				)
			)
	}
];

/**
 * Run `revocation` up to its commit, hand control to `during` with the
 * revocation still uncommitted, then release the commit and wait for the
 * request to finish.
 */
const with_uncommitted = async (
	h: Harness,
	revocation: Revocation,
	during: () => Promise<void>
): Promise<void> => {
	const held = h.gated.hold_commit();
	const request = revocation.act();
	await held.reached;
	try {
		await audit_row_landed(h, revocation.event_type);
		await during();
	} finally {
		held.release();
	}
	assert.strictEqual(await request, true, 'the revoking request succeeded');
};

/**
 * Wait until the revoking request's success audit row is visible through the
 * pool, then let the emitter's continuation run.
 *
 * The audit write is eager and pool-routed, so it lands while the revocation's
 * transaction is still held. Waiting for it fixes the schedule: a listener
 * that closes on the *write* has run before the connection opens, and found
 * nothing — only a close made after the commit can reach the connection.
 */
const audit_row_landed = async (h: Harness, event_type: string): Promise<void> => {
	const deadline = Date.now() + 2000;
	for (;;) {
		const rows = await h.db.query(
			`SELECT 1 FROM audit_log WHERE event_type = $1 AND outcome = 'success'`,
			[event_type]
		);
		if (rows.length > 0) break;
		assert.ok(Date.now() < deadline, `no '${event_type}' audit row landed within 2s`);
		await wait(5);
	}
	// the row is visible to another connection, so its INSERT has been answered;
	// yield so the emitter has read that answer
	await wait();
	await wait();
};

describe_pg('a connection admitted while its revocation is uncommitted', (get_db) => {
	install_audit_drift_guard();

	for (const site of sites) {
		describe(site.name, () => {
			/** The credential the site revokes, as a WebSocket upgrade carries it. */
			const victim_credential = async (
				h: Harness,
				revocation: Pick<Revocation, 'account' | 'session_headers'>
			): Promise<Credential> =>
				site.revokes === 'session'
					? { session_token_hash: await session_hash_of(h, revocation.session_headers) }
					: { api_token_id: await token_id_of(h, revocation.account.id) };

			test('a WebSocket is closed at the commit, by the handler', async () => {
				const h = await create_harness(get_db(), site);
				const revocation = { ...(await site.arrange(h)), event_type: site.event_type };
				const credential = await victim_credential(h, revocation);
				const endpoint = h.ws_closed_by_handlers;

				let socket: FakeWs | undefined;
				await with_uncommitted(h, revocation, async () => {
					socket = await endpoint.open(revocation.account.id, credential);
					// the re-read saw the credential alive: the delete is uncommitted
					assert.deepStrictEqual(socket.closes, [], 'admitted');
					assert.strictEqual(endpoint.transport.get_connection_count(), 1);
				});

				assert.ok(socket);
				assert.deepStrictEqual(socket.closes, [REVOKED_CLOSE], 'closed once the commit landed');
				assert.strictEqual(endpoint.transport.get_connection_count(), 0);
				await h.test_app.cleanup();
			});

			// A cap eviction writes no audit row, so no listener can close for it —
			// the handler's close above is the only one.
			test.skipIf(site.name.includes('cap eviction'))(
				'a WebSocket only the audit listener reaches is closed at the commit too',
				async () => {
					const h = await create_harness(get_db(), site);
					const revocation = { ...(await site.arrange(h)), event_type: site.event_type };
					const credential = await victim_credential(h, revocation);
					const endpoint = h.ws_closed_by_listener;

					let socket: FakeWs | undefined;
					await with_uncommitted(h, revocation, async () => {
						socket = await endpoint.open(revocation.account.id, credential);
						assert.deepStrictEqual(socket.closes, [], 'admitted');
						assert.strictEqual(endpoint.transport.get_connection_count(), 1);
					});

					assert.ok(socket);
					assert.deepStrictEqual(socket.closes, [REVOKED_CLOSE], 'closed once the commit landed');
					assert.strictEqual(endpoint.transport.get_connection_count(), 0);
					await h.test_app.cleanup();
				}
			);

			// The audit stream admits sessions only, so a token revocation has no
			// stream of its own to close.
			test.skipIf(site.revokes === 'token')('an audit stream is closed at the commit', async () => {
				const h = await create_harness(get_db(), site);
				const revocation = { ...(await site.arrange(h)), event_type: site.event_type };

				let res: Response | undefined;
				await with_uncommitted(h, revocation, async () => {
					res = await h.test_app.app.request(STREAM_PATH, {
						headers: revocation.session_headers
					});
					assert.strictEqual(res.status, 200, 'admitted');
					assert.strictEqual(h.audit_sse.registry.count, 1);
				});

				assert.ok(res);
				assert.strictEqual(h.audit_sse.registry.count, 0, 'closed once the commit landed');
				// the body ends rather than staying open
				await res.text();
				await h.test_app.cleanup();
			});
		});
	}

	// The one revocation only a listener closes for: a role grant. The WebSocket
	// transports deliberately keep the socket (the next message is
	// re-authorized); the stream has no later check.
	test('role_grant_revoke closes an audit stream admitted before its commit', async () => {
		const h = await create_harness(get_db());
		const target = await create_target(h);
		const grants = await h.db.query<{ id: Uuid }>(
			`SELECT id FROM role_grant WHERE actor_id = $1 AND role = $2`,
			[target.actor.id, ROLE_ADMIN]
		);
		assert.strictEqual(grants.length, 1);
		const revocation: Revocation = {
			event_type: 'role_grant_revoke',
			account: target.account,
			session_headers: target.create_session_headers(),
			act: () =>
				rpc(
					h,
					'role_grant_revoke',
					{ actor_id: target.actor.id, role_grant_id: grants[0]!.id },
					keeper_headers(h)
				)
		};

		let res: Response | undefined;
		await with_uncommitted(h, revocation, async () => {
			res = await h.test_app.app.request(STREAM_PATH, { headers: revocation.session_headers });
			// the role re-read saw the grant: its revocation is uncommitted
			assert.strictEqual(res.status, 200, 'admitted');
			assert.strictEqual(h.audit_sse.registry.count, 1);
		});

		assert.ok(res);
		assert.strictEqual(h.audit_sse.registry.count, 0, 'closed once the commit landed');
		await res.text();
		await h.test_app.cleanup();
	});
});
