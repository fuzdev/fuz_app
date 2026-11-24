import '../assert_dev_env.ts';

/**
 * Both spines live: two backends serving one Postgres database at once. The
 * backend swap (`backend_swap.ts`) runs them one at a time; here a credential
 * minted on one is used, revoked and refused across the other while both
 * run, and the per-process state each keeps is pinned as the declared limit
 * it is.
 *
 * Per order, over a database emptied first, never reset in between
 * (`_testing_reset` would drop what the other spine holds):
 *
 * - **Boot state** — the second spawned before the first's bootstrap. Its
 *   `/status` still advertises bootstrap and its daemon token resolves no
 *   keeper, both read once at its boot. A `POST /bootstrap` on it is refused
 *   by the database's lock, which also closes its window; its daemon token
 *   still resolves no keeper until it restarts. Both stop before the next
 *   phase.
 * - **Boot** — the first spawned, its keeper bootstrapped, then the second
 *   spawned over that database, so its daemon leg resolves the keeper at
 *   assembly (the spawn order the per-process keeper cache forces).
 * - **Live cross-spine credential honor** — mint on the first, prove it on
 *   both, revoke on the second, refused on the first at once: a session
 *   logged out and one revoked by id, an API token revoked, a password
 *   changed, an account deleted; and an offer the first made accepted on the
 *   second, after which the first's admin gate passes. Each revoke is
 *   bracketed by per-table content digests read after both backends drain,
 *   so the tables it changed are exactly the ones it should, and every test
 *   ends with both backends' invariant check.
 * - **Declared limits** — what each process keeps to itself, pinned by name
 *   (`docs/security.md` § Single-Process Architecture): a socket open on the
 *   first outlives the second's password change, logout and token revoke,
 *   and keeps answering per-message calls; a role-gated socket on the first
 *   outlives the second's role revoke and keeps receiving the account's
 *   pushes; an offer made on either notifies no socket on the other. Each
 *   assertion holds the current behavior, so a cross-process close or
 *   notification that lands within `STAYS_OPEN_MS` fails it loudly — then
 *   the limit is lifted and the test flipped.
 * - **Close** — both drained, invariants checked on both, then each torn down
 *   (exit `0`, no unexpected error in its log, `spawn_backend`).
 *
 * **What the configs must share** is the swap's
 * (`to_shared_database_problems`): the database (`DATABASE_URL`, exact
 * strings), the cookie name and `SECRET_FUZ_COOKIE_KEYS`, and the drain and
 * invariant backdoors. Their daemon-token, bootstrap
 * token and fact directories stay their own (each config's paths). The
 * socket cases run when the first backend declares `ws` and
 * `ws_account_actions` (and `ws_role_gated` for the gated case; `ws` and
 * `ws_account_actions` on both for the notification case).
 *
 * @module
 */

import { afterAll, assert, beforeAll, describe, test } from 'vitest';

import {
	SessionListOutput,
	SessionRevokeOutput,
	TokenCreateOutput,
	TokenRevokeOutput
} from '../../auth/account_action_specs.ts';
import type { SessionAccountJson } from '../../auth/account_schema.ts';
import { AccountDeleteOutput, InviteCreateOutput } from '../../auth/admin_action_specs.ts';
import {
	RoleGrantAssignOutput,
	RoleGrantOfferAcceptOutput,
	RoleGrantOfferCreateOutput,
	RoleGrantOfferHistoryOutput,
	RoleGrantOfferListOutput,
	RoleGrantRevokeOutput
} from '../../auth/role_grant_offer_action_specs.ts';
import { ROLE_GRANT_OFFER_RECEIVED_NOTIFICATION_METHOD } from '../../auth/role_grant_offer_notifications.ts';
import { ROLE_ADMIN } from '../../auth/role_schema.ts';
import { create_db } from '../../db/create_db.ts';
import type { Db } from '../../db/db.ts';
import {
	ERROR_ALREADY_BOOTSTRAPPED,
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS,
	ERROR_INVALID_CREDENTIALS
} from '../../http/error_schemas.ts';
import { bootstrap } from '../transports/bootstrap.ts';
import { is_notification_with } from '../transports/ws_client.ts';
import {
	create_admitted_ws_transport,
	type WsTransportClient
} from '../transports/ws_transport.ts';
import type { BackendConfig } from './backend_config.ts';
import { test_if } from './capabilities.ts';
import { error_reason } from './cross_rpc.ts';
import { spawn_backend, type BackendHandle } from './spawn_backend.ts';
import {
	assert_backend_invariants,
	backend_daemon_rpc,
	backend_post_json,
	backend_rpc_as,
	backend_transport,
	drain_backend_effects,
	passes_admin_gate,
	read_shared_database_snapshot,
	teardown_live_backend,
	to_changed_tables,
	to_shared_database_problems,
	verified_account_id,
	with_live_backend,
	type LiveBackend,
	type SharedDatabaseOrder,
	type SharedDatabaseSnapshot
} from './shared_database_backends.ts';
import {
	SPINE_ACCOUNT_LOGIN_PATH,
	SPINE_ACCOUNT_LOGOUT_PATH,
	SPINE_ACCOUNT_PASSWORD_PATH,
	SPINE_ACCOUNT_SIGNUP_PATH,
	SPINE_ACCOUNT_STATUS_PATH,
	SPINE_PARTICIPANT_ROLE,
	SPINE_ROLE_GATED_WS_PATH
} from './spine_surface_constants.ts';

/** Options for `describe_backend_both_live_tests`. */
export interface BackendBothLiveTestOptions {
	/**
	 * The orders to run (`SharedDatabaseOrder`), one after another over the one
	 * database: `first` boots and bootstraps, `second` boots over it, and both
	 * then run at once.
	 */
	readonly orders: ReadonlyArray<SharedDatabaseOrder>;
	/**
	 * The `postgres://` database both configs run over (a `TestDatabase`'s
	 * URL), read directly for the snapshots — each config's `DATABASE_URL` env
	 * must be this exact string.
	 */
	readonly database_url: string;
	/**
	 * Empty the database — each order calls it before each of its two spawn
	 * sequences, so the keeper bootstrap finds no account — the
	 * `TestDatabase`'s `empty()`, or `empty_test_database` over its URL.
	 */
	readonly empty_database: () => Promise<void>;
	/**
	 * The role of the offer the notification case makes on the first — one the
	 * keeper may offer, other than `admin`, which the gated socket's grant, the
	 * accepted offer and the reverse notification offer use. Default
	 * `SPINE_PARTICIPANT_ROLE`, which the reference spines register.
	 */
	readonly offer_role?: string;
	/**
	 * The first backend's role-gated WebSocket endpoint, which must admit a
	 * global `admin` grant. Default `SPINE_ROLE_GATED_WS_PATH`.
	 */
	readonly gated_ws_path?: string;
}

const MEMBER_PASSWORD = 'both-live-password-before';
const MEMBER_PASSWORD_CHANGED = 'both-live-password-after';

/**
 * How long a socket that must stay open, or must hear nothing, is watched —
 * long past the same-process close the other suites see in milliseconds.
 */
const STAYS_OPEN_MS = 1500;

/** What a spawning test may take past its backends' startup windows (ms). */
const BOTH_LIVE_PHASE_WORK_MS = 30_000;

/** The tables a step writes, by the spine-owned table names. */
const TABLE_AUDIT_LOG = 'public.audit_log';
const TABLE_AUTH_SESSION = 'public.auth_session';
const TABLE_API_TOKEN = 'public.api_token';
const TABLE_ACCOUNT = 'public.account';
const TABLE_ACTOR = 'public.actor';
const TABLE_ROLE_GRANT = 'public.role_grant';
const TABLE_ROLE_GRANT_OFFER = 'public.role_grant_offer';

/** Both running backends of an order and the keeper the first bootstrapped. */
interface BothLive {
	readonly a: BackendHandle;
	readonly b: BackendHandle;
	readonly keeper_id: string;
	/** The keeper's session cookie from the first backend's bootstrap — valid on both. */
	readonly keeper_cookies: ReadonlyArray<string>;
}

/** A member the keeper invited and the first backend signed up. */
interface Member {
	readonly username: string;
	readonly account_id: string;
	readonly actor_id: string;
}

/** The `Cookie` pair of each `Set-Cookie` line, for a socket upgrade. */
const to_cookie_pairs = (set_cookies: ReadonlyArray<string>): Array<string> =>
	set_cookies.map((line) => line.split(';')[0]!.trim());

/** Log `username` in on `config`'s backend, asserting it succeeds; its `Set-Cookie` lines. */
const login = async (
	config: BackendConfig,
	username: string,
	password: string
): Promise<ReadonlyArray<string>> => {
	const res = await backend_post_json(backend_transport(config), SPINE_ACCOUNT_LOGIN_PATH, {
		username,
		password
	});
	assert.strictEqual(res.status, 200, `${config.name}: ${username} logs in`);
	assert.strictEqual(res.set_cookies.length, 1, 'a login sets exactly the session cookie');
	return res.set_cookies;
};

/** A login on `config` refused 401 `invalid_credentials`. */
const assert_login_refused = async (
	config: BackendConfig,
	username: string,
	password: string,
	message: string
): Promise<void> => {
	const res = await backend_post_json(backend_transport(config), SPINE_ACCOUNT_LOGIN_PATH, {
		username,
		password
	});
	assert.strictEqual(res.status, 401, `${config.name}: ${message}`);
	assert.strictEqual((res.body as { error?: unknown }).error, ERROR_INVALID_CREDENTIALS);
};

/** The keeper invites `username` on the first backend, which signs it up. */
const create_member = async (live: BothLive, username: string): Promise<Member> => {
	const { config } = live.a;
	await backend_rpc_as(
		config,
		live.keeper_cookies,
		'invite_create',
		{ username },
		InviteCreateOutput
	);
	const signup = await backend_post_json(backend_transport(config), SPINE_ACCOUNT_SIGNUP_PATH, {
		username,
		password: MEMBER_PASSWORD
	});
	assert.strictEqual(signup.status, 200, `signup: ${JSON.stringify(signup.body)}`);
	const body = signup.body as { account: { id: string }; actor: { id: string } };
	return { username, account_id: body.account.id, actor_id: body.actor.id };
};

/** Mint a full eternal API token on `config` over a session. */
const create_token = (config: BackendConfig, cookies: ReadonlyArray<string>) =>
	backend_rpc_as(
		config,
		cookies,
		'account_token_create',
		{ scope: { kind: 'full' }, lifetime: { kind: 'eternal' } },
		TokenCreateOutput
	);

/** Assert a credential authenticates as `account_id` on both backends. */
const assert_live_on_both = async (
	live: BothLive,
	credential: { cookies: ReadonlyArray<string> } | { bearer: string },
	account_id: string,
	what: string
): Promise<void> => {
	for (const { config } of [live.a, live.b]) {
		assert.strictEqual(
			await verified_account_id(config, credential),
			account_id,
			`${config.name}: ${what} authenticates`
		);
	}
};

/** Assert a credential is refused 401 on `handle`'s backend. */
const assert_refused = async (
	handle: BackendHandle,
	credential: { cookies: ReadonlyArray<string> } | { bearer: string },
	what: string
): Promise<void> => {
	assert.isNull(
		await verified_account_id(handle.config, credential),
		`${handle.config.name}: ${what} is refused`
	);
};

const drain_both = async (live: BothLive): Promise<void> => {
	await drain_backend_effects(live.a);
	await drain_backend_effects(live.b);
};

/** Drain both backends, then read the snapshot — nothing detached lands after it. */
const drained_snapshot = async (live: BothLive, db: Db): Promise<SharedDatabaseSnapshot> => {
	await drain_both(live);
	return read_shared_database_snapshot(db);
};

const assert_invariants_both = async (live: BothLive): Promise<void> => {
	await assert_backend_invariants(live.a);
	await assert_backend_invariants(live.b);
};

/**
 * Assert the tables that changed between two drained snapshots are exactly
 * `expected` — a step that wrote less missed its write, one that wrote more
 * wrote what it shouldn't.
 */
const assert_changed_tables = (
	before: SharedDatabaseSnapshot,
	after: SharedDatabaseSnapshot,
	expected: ReadonlyArray<string>,
	step: string
): void => {
	assert.deepStrictEqual(
		to_changed_tables(before, after),
		[...expected].sort(),
		`the tables ${step} changed`
	);
};

/** Open an admitted socket on `config`'s `ws_path` (or `path`) on a session. */
const open_session_socket = (
	config: BackendConfig,
	cookies: ReadonlyArray<string>,
	path: string = config.ws_path
): Promise<WsTransportClient> =>
	create_admitted_ws_transport({
		base_url: config.base_url,
		ws_path: path,
		cookies: to_cookie_pairs(cookies)
	});

/** Open an admitted socket on `config`'s `ws_path` on a bearer token (Origin-free). */
const open_bearer_socket = (config: BackendConfig, token: string): Promise<WsTransportClient> =>
	create_admitted_ws_transport({
		base_url: config.base_url,
		ws_path: config.ws_path,
		cookies: [],
		origin: null,
		headers: { authorization: `Bearer ${token}` }
	});

/**
 * Assert `socket` stays open past `STAYS_OPEN_MS` and still answers a
 * per-message `account_verify` as `account_id` — dispatch re-reads the actor
 * and its grants, never the session or token the socket opened on.
 */
const assert_socket_still_serves = async (
	socket: WsTransportClient,
	account_id: string,
	limit: string
): Promise<void> => {
	assert.isFalse(
		await socket.wait_for_close(STAYS_OPEN_MS),
		`${limit}: the socket closed (${socket.close_code}) — a cross-process close landed? ` +
			'lift the declared limit and flip this test'
	);
	const verified = await socket.request<SessionAccountJson>(
		'still_serves',
		'account_verify',
		undefined
	);
	assert.strictEqual(verified.id, account_id, `${limit}: the socket still acts as the account`);
};

/** Close sockets, ignoring a socket the server already closed. */
const close_sockets = async (sockets: ReadonlyArray<WsTransportClient | null>): Promise<void> => {
	for (const socket of sockets) {
		await socket?.close().catch(() => {});
	}
};

/** The anonymous `/status` answer: its status and `bootstrap_available`. */
const read_status = async (
	config: BackendConfig
): Promise<{ status: number; bootstrap_available: unknown }> => {
	const res = await backend_transport(config)(SPINE_ACCOUNT_STATUS_PATH, { method: 'GET' });
	const body = (await res.json()) as { bootstrap_available?: unknown };
	return { status: res.status, bootstrap_available: body.bootstrap_available };
};

/**
 * Throw naming each way `order`'s configs can't run at once over
 * `database_url` (`to_shared_database_problems`, and `offer_role` not `admin`).
 */
const assert_both_live = (
	order: SharedDatabaseOrder,
	database_url: string,
	offer_role: string
): void => {
	const problems: Array<string> = [];
	if (offer_role === ROLE_ADMIN) {
		problems.push(
			`offer_role is ${ROLE_ADMIN}, the role the gated socket's grant, the accepted offer and the reverse notification offer use`
		);
	}
	problems.push(...to_shared_database_problems([order.first, order.second], database_url));
	if (problems.length > 0) {
		throw new Error(`backend both live '${order.label}': ${problems.join('; ')}`);
	}
};

/**
 * Describe both spines live over each order (§module doc): per order, the
 * boot-state limits, the boot, the live cross-spine credential cases, the
 * declared per-process limits, and the close, run in turn. Each test after the
 * boot fails naming it when the boot did not complete.
 *
 * @param options - the orders, the shared database, and how to empty it
 */
export const describe_backend_both_live_tests = (options: BackendBothLiveTestOptions): void => {
	const {
		orders,
		database_url,
		empty_database,
		offer_role = SPINE_PARTICIPANT_ROLE,
		gated_ws_path = SPINE_ROLE_GATED_WS_PATH
	} = options;

	describe('backend both live', () => {
		let db: Db | null = null;
		let close_db: (() => Promise<void>) | null = null;
		beforeAll(async () => {
			const created = await create_db(database_url);
			db = created.db;
			close_db = created.close;
		});
		afterAll(async () => {
			await close_db?.();
		});
		const get_db = (): Db => {
			assert.ok(db, 'the snapshot connection is open');
			return db;
		};

		for (const order of orders) {
			const { label, first, second } = order;
			const spawn_timeout =
				first.startup_timeout_ms + second.startup_timeout_ms + BOTH_LIVE_PHASE_WORK_MS;
			const first_live: LiveBackend = { handle: null };
			const second_live: LiveBackend = { handle: null };
			const state: { keeper?: { id: string; cookies: ReadonlyArray<string> } } = {};
			const get_live = (): BothLive => {
				const a = first_live.handle;
				const b = second_live.handle;
				assert.ok(a && b && state.keeper, 'both backends booted (the boot test passed)');
				return { a, b, keeper_id: state.keeper.id, keeper_cookies: state.keeper.cookies };
			};
			const ws_first = first.capabilities.ws && first.capabilities.ws_account_actions;

			describe(label, () => {
				afterAll(async () => {
					await teardown_live_backend(second_live);
					await teardown_live_backend(first_live);
				});

				// Declared limit (docs/security.md § Single-Process Architecture):
				// `/status`'s `bootstrap_available` and the daemon leg's keeper are
				// read once per process, at boot — the reason the boot below spawns
				// the second backend only after the first's bootstrap.
				test(
					`declared limit: ${second.name} booted before ${first.name}'s bootstrap keeps its boot-time bootstrap state`,
					async () => {
						assert_both_live(order, database_url, offer_role);
						await empty_database();
						await with_live_backend(first, first_live, (a) =>
							with_live_backend(second, second_live, async (b) => {
								const before = await read_status(b.config);
								assert.strictEqual(before.status, 401);
								assert.strictEqual(
									before.bootstrap_available,
									true,
									`${b.config.name} advertises bootstrap over the empty database`
								);

								await bootstrap({ transport: backend_transport(a.config), config: a.config });
								const own = await read_status(a.config);
								assert.notStrictEqual(
									own.bootstrap_available,
									true,
									`${a.config.name} closed bootstrap on its own`
								);

								const stale = await read_status(b.config);
								assert.strictEqual(
									stale.bootstrap_available,
									true,
									`declared limit: ${b.config.name}'s /status still advertises bootstrap ` +
										"after the other spine's — a re-read landed? lift the limit and flip this"
								);
								const keeperless = await backend_daemon_rpc(b, '_testing_drain_effects');
								assert.strictEqual(
									keeperless.status,
									401,
									`declared limit: ${b.config.name}'s daemon token resolves no keeper ` +
										'until it restarts — a re-resolve landed? lift the limit and flip this'
								);
								assert.strictEqual(error_reason(keeperless), ERROR_AUTHENTICATION_REQUIRED);
								// the window it advertises is closed where it counts: the lock
								const rebootstrap = await backend_post_json(
									backend_transport(b.config),
									b.config.bootstrap_path,
									{
										token: b.config.bootstrap.token,
										username: b.config.bootstrap.username,
										password: b.config.bootstrap.password
									}
								);
								assert.strictEqual(rebootstrap.status, 403, 'the stale window bootstraps nothing');
								assert.strictEqual(
									(rebootstrap.body as { error?: unknown }).error,
									ERROR_ALREADY_BOOTSTRAPPED
								);
								const closed = await read_status(b.config);
								assert.notStrictEqual(
									closed.bootstrap_available,
									true,
									`${b.config.name}: the lock refusal closes its window`
								);
								// the second's daemon leg can't drain it (the limit above);
								// its teardown awaits what it holds
								await drain_backend_effects(a);
								await assert_backend_invariants(a);
							})
						);
					},
					spawn_timeout
				);

				test(
					`${first.name} bootstraps over an empty database and ${second.name} boots over it`,
					async () => {
						assert_both_live(order, database_url, offer_role);
						await empty_database();
						const a = await spawn_backend(first);
						first_live.handle = a;
						const keeper = await bootstrap({
							transport: backend_transport(a.config),
							config: a.config
						});
						await drain_backend_effects(a);
						const b = await spawn_backend(second);
						second_live.handle = b;
						state.keeper = { id: keeper.account.id, cookies: keeper.cookies };
						const live = get_live();

						// the second's boot resolved the keeper the first bootstrapped
						await drain_backend_effects(b);
						const status = await read_status(b.config);
						assert.strictEqual(status.status, 401);
						assert.notStrictEqual(status.bootstrap_available, true, 'bootstrap is closed');
						await assert_live_on_both(
							live,
							{ cookies: keeper.cookies },
							keeper.account.id,
							"the keeper's cookie"
						);
						await assert_invariants_both(live);
					},
					spawn_timeout
				);

				describe('live cross-spine credential honor', () => {
					test(`a session minted on ${first.name}, logged out on ${second.name}`, async () => {
						const live = get_live();
						const member = await create_member(live, 'live_logout');
						const cookies = await login(first, member.username, MEMBER_PASSWORD);
						const spare = await login(first, member.username, MEMBER_PASSWORD);
						await assert_live_on_both(live, { cookies }, member.account_id, 'the session');

						const before = await drained_snapshot(live, get_db());
						const logout = await backend_post_json(
							backend_transport(second, cookies),
							SPINE_ACCOUNT_LOGOUT_PATH,
							{}
						);
						assert.strictEqual(logout.status, 200, `${second.name} logs the session out`);
						await assert_refused(live.a, { cookies }, 'the logged-out session');
						await assert_refused(live.b, { cookies }, 'the logged-out session');
						// logout ends one session, not the account's others
						await assert_live_on_both(
							live,
							{ cookies: spare },
							member.account_id,
							'the spare session'
						);
						const after = await drained_snapshot(live, get_db());
						assert_changed_tables(before, after, [TABLE_AUTH_SESSION, TABLE_AUDIT_LOG], 'logout');
						await assert_invariants_both(live);
					});

					test(`a session minted on ${first.name}, revoked by id on ${second.name}`, async () => {
						const live = get_live();
						const member = await create_member(live, 'live_session_revoke');
						const target = await login(first, member.username, MEMBER_PASSWORD);
						const revoker = await login(second, member.username, MEMBER_PASSWORD);
						await assert_live_on_both(live, { cookies: target }, member.account_id, 'the target');
						const { sessions } = await backend_rpc_as(
							first,
							target,
							'account_session_list',
							undefined,
							SessionListOutput
						);
						const current = sessions.find((s) => s.is_current);
						assert.ok(current, 'the session list names the caller');

						const before = await drained_snapshot(live, get_db());
						const revoked = await backend_rpc_as(
							second,
							revoker,
							'account_session_revoke',
							{ session_id: current.id },
							SessionRevokeOutput
						);
						assert.isTrue(revoked.revoked, `${second.name} revokes the session`);
						await assert_refused(live.a, { cookies: target }, 'the revoked session');
						await assert_refused(live.b, { cookies: target }, 'the revoked session');
						await assert_live_on_both(
							live,
							{ cookies: revoker },
							member.account_id,
							'the revoking session'
						);
						const after = await drained_snapshot(live, get_db());
						assert_changed_tables(
							before,
							after,
							[TABLE_AUTH_SESSION, TABLE_AUDIT_LOG],
							'the session revoke'
						);
						await assert_invariants_both(live);
					});

					test(`an API token minted on ${first.name}, revoked on ${second.name}`, async () => {
						const live = get_live();
						const member = await create_member(live, 'live_token');
						const cookies = await login(first, member.username, MEMBER_PASSWORD);
						const token = await create_token(first, cookies);
						const spare = await create_token(first, cookies);
						await assert_live_on_both(
							live,
							{ bearer: token.token },
							member.account_id,
							'the token'
						);

						const before = await drained_snapshot(live, get_db());
						const revoked = await backend_rpc_as(
							second,
							cookies,
							'account_token_revoke',
							{ token_id: token.id },
							TokenRevokeOutput
						);
						assert.isTrue(revoked.revoked, `${second.name} revokes the token`);
						await assert_refused(live.a, { bearer: token.token }, 'the revoked token');
						await assert_refused(live.b, { bearer: token.token }, 'the revoked token');
						// the revoke ends one token, not the account's others
						await assert_live_on_both(
							live,
							{ bearer: spare.token },
							member.account_id,
							'the spare token'
						);
						await assert_live_on_both(live, { cookies }, member.account_id, 'the session');
						const after = await drained_snapshot(live, get_db());
						assert_changed_tables(before, after, [TABLE_API_TOKEN, TABLE_AUDIT_LOG], 'the revoke');
						await assert_invariants_both(live);
					});

					test(`a password changed on ${second.name} ends ${first.name}'s credentials`, async () => {
						const live = get_live();
						const member = await create_member(live, 'live_password');
						const session = await login(first, member.username, MEMBER_PASSWORD);
						const token = await create_token(first, session);
						const changer = await login(second, member.username, MEMBER_PASSWORD);
						await assert_live_on_both(live, { cookies: session }, member.account_id, 'the session');
						await assert_live_on_both(
							live,
							{ bearer: token.token },
							member.account_id,
							'the token'
						);

						const before = await drained_snapshot(live, get_db());
						const changed = await backend_post_json(
							backend_transport(second, changer),
							SPINE_ACCOUNT_PASSWORD_PATH,
							{ current_password: MEMBER_PASSWORD, new_password: MEMBER_PASSWORD_CHANGED }
						);
						assert.strictEqual(
							changed.status,
							200,
							`password change: ${JSON.stringify(changed.body)}`
						);
						await assert_refused(live.a, { cookies: session }, "the first spine's session");
						await assert_refused(live.a, { bearer: token.token }, "the first spine's token");
						await assert_refused(live.b, { cookies: session }, "the first spine's session");
						await assert_refused(live.b, { bearer: token.token }, "the first spine's token");
						await assert_refused(live.a, { cookies: changer }, 'the changing session');
						await assert_login_refused(
							first,
							member.username,
							MEMBER_PASSWORD,
							'the old password is refused'
						);
						const after = await drained_snapshot(live, get_db());
						assert_changed_tables(
							before,
							after,
							[TABLE_ACCOUNT, TABLE_AUTH_SESSION, TABLE_API_TOKEN, TABLE_AUDIT_LOG],
							'the password change'
						);
						await login(first, member.username, MEMBER_PASSWORD_CHANGED);
						await assert_invariants_both(live);
					});

					test(`an offer made on ${first.name}, accepted on ${second.name}`, async () => {
						const live = get_live();
						const member = await create_member(live, 'live_offer');
						const cookies = await login(first, member.username, MEMBER_PASSWORD);
						const { offer } = await backend_rpc_as(
							first,
							live.keeper_cookies,
							'role_grant_offer_create',
							{ to_account_id: member.account_id, role: ROLE_ADMIN },
							RoleGrantOfferCreateOutput
						);
						const { offers } = await backend_rpc_as(
							second,
							cookies,
							'role_grant_offer_list',
							undefined,
							RoleGrantOfferListOutput
						);
						assert.deepStrictEqual(
							offers.map((o) => o.id),
							[offer.id],
							`${second.name} lists the offer`
						);
						assert.isFalse(await passes_admin_gate(first, cookies), 'no admin before the accept');

						const before = await drained_snapshot(live, get_db());
						const accepted = await backend_rpc_as(
							second,
							cookies,
							'role_grant_offer_accept',
							{ offer_id: offer.id },
							RoleGrantOfferAcceptOutput
						);
						assert.isTrue(
							await passes_admin_gate(first, cookies),
							`${first.name} honors the grant at once`
						);
						const history = await backend_rpc_as(
							first,
							live.keeper_cookies,
							'role_grant_offer_history',
							{},
							RoleGrantOfferHistoryOutput
						);
						const read = history.offers.find((o) => o.id === offer.id);
						assert.ok(read, "the keeper's history lists the offer");
						assert.strictEqual(read.resulting_role_grant_id, accepted.role_grant_id);
						const after = await drained_snapshot(live, get_db());
						assert_changed_tables(
							before,
							after,
							[TABLE_ROLE_GRANT, TABLE_ROLE_GRANT_OFFER, TABLE_AUDIT_LOG],
							'the accept'
						);
						await assert_invariants_both(live);
					});

					test(`an account deleted on ${second.name} ends ${first.name}'s credentials`, async () => {
						const live = get_live();
						const member = await create_member(live, 'live_delete');
						const session = await login(first, member.username, MEMBER_PASSWORD);
						const token = await create_token(first, session);
						const deleter = await login(second, member.username, MEMBER_PASSWORD);
						await assert_live_on_both(live, { cookies: session }, member.account_id, 'the session');
						await assert_live_on_both(
							live,
							{ bearer: token.token },
							member.account_id,
							'the token'
						);

						const before = await drained_snapshot(live, get_db());
						const deleted = await backend_rpc_as(
							second,
							deleter,
							'account_delete',
							{},
							AccountDeleteOutput
						);
						assert.isTrue(deleted.deleted, `${second.name} deletes the account`);
						await assert_refused(live.a, { cookies: session }, "the deleted account's session");
						await assert_refused(live.a, { bearer: token.token }, "the deleted account's token");
						await assert_refused(live.b, { cookies: session }, "the deleted account's session");
						await assert_refused(live.b, { bearer: token.token }, "the deleted account's token");
						await assert_login_refused(
							first,
							member.username,
							MEMBER_PASSWORD,
							"the deleted account's password is refused"
						);
						const after = await drained_snapshot(live, get_db());
						assert_changed_tables(
							before,
							after,
							[TABLE_ACCOUNT, TABLE_ACTOR, TABLE_AUTH_SESSION, TABLE_API_TOKEN, TABLE_AUDIT_LOG],
							'the delete'
						);
						await assert_invariants_both(live);
					});
				});

				// Each case pins a declared limit (docs/security.md § Single-Process
				// Architecture): a revocation closes the connections of its own
				// process only, and a notification reaches its own process's
				// sockets only. HTTP on both spines proves each revocation landed,
				// so the socket outliving it is the limit, not a vacuous revoke.
				describe('declared limits', () => {
					test_if(
						ws_first,
						`declared limit: a socket on ${first.name} outlives a password change on ${second.name}`,
						async () => {
							const live = get_live();
							const member = await create_member(live, 'limit_password');
							const session = await login(first, member.username, MEMBER_PASSWORD);
							const changer = await login(second, member.username, MEMBER_PASSWORD);
							let socket: WsTransportClient | null = null;
							try {
								socket = await open_session_socket(first, session);
								const changed = await backend_post_json(
									backend_transport(second, changer),
									SPINE_ACCOUNT_PASSWORD_PATH,
									{ current_password: MEMBER_PASSWORD, new_password: MEMBER_PASSWORD_CHANGED }
								);
								assert.strictEqual(changed.status, 200);
								await assert_refused(live.a, { cookies: session }, 'the old session');
								await assert_refused(live.b, { cookies: session }, 'the old session');
								await assert_socket_still_serves(
									socket,
									member.account_id,
									'password change across processes'
								);
							} finally {
								await close_sockets([socket]);
							}
							await drain_both(live);
							await assert_invariants_both(live);
						}
					);

					test_if(
						ws_first,
						`declared limit: a socket on ${first.name} outlives its session's logout on ${second.name}`,
						async () => {
							const live = get_live();
							const member = await create_member(live, 'limit_logout');
							const session = await login(first, member.username, MEMBER_PASSWORD);
							let socket: WsTransportClient | null = null;
							try {
								socket = await open_session_socket(first, session);
								const logout = await backend_post_json(
									backend_transport(second, session),
									SPINE_ACCOUNT_LOGOUT_PATH,
									{}
								);
								assert.strictEqual(logout.status, 200);
								await assert_refused(live.a, { cookies: session }, 'the logged-out session');
								await assert_refused(live.b, { cookies: session }, 'the logged-out session');
								await assert_socket_still_serves(
									socket,
									member.account_id,
									'logout across processes'
								);
							} finally {
								await close_sockets([socket]);
							}
							await drain_both(live);
							await assert_invariants_both(live);
						}
					);

					test_if(
						ws_first,
						`declared limit: a socket on ${first.name} outlives its token's revoke on ${second.name}`,
						async () => {
							const live = get_live();
							const member = await create_member(live, 'limit_token');
							const session = await login(first, member.username, MEMBER_PASSWORD);
							const token = await create_token(first, session);
							let socket: WsTransportClient | null = null;
							try {
								socket = await open_bearer_socket(first, token.token);
								const revoked = await backend_rpc_as(
									second,
									session,
									'account_token_revoke',
									{ token_id: token.id },
									TokenRevokeOutput
								);
								assert.isTrue(revoked.revoked);
								await assert_refused(live.a, { bearer: token.token }, 'the revoked token');
								await assert_refused(live.b, { bearer: token.token }, 'the revoked token');
								await assert_socket_still_serves(
									socket,
									member.account_id,
									'token revoke across processes'
								);
							} finally {
								await close_sockets([socket]);
							}
							await drain_both(live);
							await assert_invariants_both(live);
						}
					);

					test_if(
						ws_first && first.capabilities.ws_role_gated,
						`declared limit: a role-gated socket on ${first.name} outlives the role's revoke on ${second.name}`,
						async () => {
							const live = get_live();
							const member = await create_member(live, 'limit_role');
							const { role_grant_id } = await backend_rpc_as(
								first,
								live.keeper_cookies,
								'role_grant_assign',
								{ to_account_id: member.account_id, role: ROLE_ADMIN },
								RoleGrantAssignOutput
							);
							const session = await login(first, member.username, MEMBER_PASSWORD);
							let socket: WsTransportClient | null = null;
							try {
								// admitted at the gate: the grant is live on the first
								socket = await open_session_socket(first, session, gated_ws_path);
								await socket.request('admin_before', 'invite_list', undefined);
								const revoked = await backend_rpc_as(
									second,
									live.keeper_cookies,
									'role_grant_revoke',
									{ actor_id: member.actor_id, role_grant_id },
									RoleGrantRevokeOutput
								);
								assert.isTrue(revoked.revoked);
								assert.isFalse(await passes_admin_gate(first, session), 'the role is gone');
								assert.isFalse(await passes_admin_gate(second, session), 'the role is gone');
								assert.isFalse(
									await socket.wait_for_close(STAYS_OPEN_MS),
									`declared limit: the gated socket closed (${socket.close_code}) on the ` +
										"other process's role revoke — lift the limit and flip this test"
								);
								// per-message dispatch re-reads the grants: the socket keeps
								// the gate's pushes, not the role's actions
								const refused = await socket.request('admin_after', 'invite_list', undefined).then(
									() => null,
									(err: unknown) => err
								);
								assert.ok(
									refused instanceof Error,
									'the revoked role still authorizes a per-message call'
								);
								assert.include(
									refused.message,
									`"reason":"${ERROR_INSUFFICIENT_PERMISSIONS}"`,
									'refused for the role'
								);
								const { offer } = await backend_rpc_as(
									first,
									live.keeper_cookies,
									'role_grant_offer_create',
									{ to_account_id: member.account_id, role: offer_role },
									RoleGrantOfferCreateOutput
								);
								await socket.wait_for(
									is_notification_with<{ offer: { id: string } }>(
										ROLE_GRANT_OFFER_RECEIVED_NOTIFICATION_METHOD,
										(p) => p.offer.id === offer.id
									),
									5000
								);
							} finally {
								await close_sockets([socket]);
							}
							await drain_both(live);
							await assert_invariants_both(live);
						}
					);

					test_if(
						ws_first && second.capabilities.ws && second.capabilities.ws_account_actions,
						`declared limit: an offer made on either of ${first.name} and ${second.name} notifies no socket on the other`,
						async () => {
							const live = get_live();
							const member = await create_member(live, 'limit_notify');
							const session = await login(first, member.username, MEMBER_PASSWORD);
							let near: WsTransportClient | null = null;
							let far: WsTransportClient | null = null;
							try {
								near = await open_session_socket(first, session);
								far = await open_session_socket(second, session);
								const { offer } = await backend_rpc_as(
									first,
									live.keeper_cookies,
									'role_grant_offer_create',
									{ to_account_id: member.account_id, role: offer_role },
									RoleGrantOfferCreateOutput
								);
								const is_this_offer = is_notification_with<{ offer: { id: string } }>(
									ROLE_GRANT_OFFER_RECEIVED_NOTIFICATION_METHOD,
									(p) => p.offer.id === offer.id
								);
								// the control: the offering process's socket hears it
								await near
									.wait_for(is_this_offer, 5000)
									.catch(() =>
										assert.fail(`${first.name}'s own socket hears its offer (the near control)`)
									);
								const heard = await far.wait_for(is_this_offer, STAYS_OPEN_MS).then(
									() => true,
									() => false
								);
								assert.isFalse(
									heard,
									`declared limit: ${second.name}'s socket heard ${first.name}'s offer — ` +
										'a cross-process notification landed? lift the limit and flip this test'
								);
								// the far control, and the reverse direction: an offer made on
								// the second reaches its own socket and not the first's (a
								// different role, so it is a new offer, not the pending one)
								const { offer: far_offer } = await backend_rpc_as(
									second,
									live.keeper_cookies,
									'role_grant_offer_create',
									{ to_account_id: member.account_id, role: ROLE_ADMIN },
									RoleGrantOfferCreateOutput
								);
								const is_far_offer = is_notification_with<{ offer: { id: string } }>(
									ROLE_GRANT_OFFER_RECEIVED_NOTIFICATION_METHOD,
									(p) => p.offer.id === far_offer.id
								);
								await far
									.wait_for(is_far_offer, 5000)
									.catch(() =>
										assert.fail(`${second.name}'s own socket hears its offer (the far control)`)
									);
								const heard_reverse = await near.wait_for(is_far_offer, STAYS_OPEN_MS).then(
									() => true,
									() => false
								);
								assert.isFalse(
									heard_reverse,
									`declared limit: ${first.name}'s socket heard ${second.name}'s offer — ` +
										'a cross-process notification landed? lift the limit and flip this test'
								);
							} finally {
								await close_sockets([near, far]);
							}
							await drain_both(live);
							await assert_invariants_both(live);
						}
					);
				});

				test(
					'both drain, hold their invariants, and stop cleanly',
					async () => {
						const live = get_live();
						await drain_both(live);
						await assert_invariants_both(live);
						second_live.handle = null;
						await live.b.teardown();
						first_live.handle = null;
						await live.a.teardown();
					},
					spawn_timeout
				);
			});
		}
	});
};
