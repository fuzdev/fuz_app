import '../assert_dev_env.ts';

/**
 * The backend swap: two spines, one database, one at a time. The first
 * mints credentials and writes rows through its real routes, stops, and the
 * second boots over the database as the first left it and honors every one;
 * then the first boots again and honors what the second wrote. It is what
 * makes the TS and Rust spines twins in deployment, not only on the wire: a
 * consumer swaps one for the other without re-bootstrapping, and every
 * session, token, password, invite and offer carries over.
 *
 * Nothing is seeded behind the spines' backs — no `_testing_reset`, no
 * minted session. Per order, mint on the first, use on the second, check on
 * the first again:
 *
 * - **First** — the keeper bootstrap, a second keeper session and a keeper
 *   API token, an invite, the member's signup and login, a member API token,
 *   two pending offers to the member — `admin`, and `declined_role` to its
 *   actor (one role each: a second offer of a role still pending answers the
 *   first); the schema-version rows and a digest of every table's content
 *   read over Postgres.
 * - **Second** — before any request, the migrations and every table's
 *   content as the first left them (its boot applied no migration and
 *   rewrote no row); bootstrap closed on `/status` and refused on
 *   `POST /bootstrap`; every cookie and both tokens authenticate; the
 *   member's password logs in and a wrong one is refused (an Argon2id hash
 *   verified by the other spine's verifier); both offers listed pending, one
 *   declined, one accepted, after which the member passes the admin gate;
 *   no database invariant broken; then the revocations — the second keeper
 *   session logged out and the keeper token revoked, each refused there, and
 *   the member's password changed.
 * - **First again** — the migrations unchanged; the logged-out keeper
 *   session and the revoked keeper token refused while the first keeper
 *   cookie still authenticates (the revocations the second wrote, which
 *   nothing else ended); the member's sessions on both spines and its token
 *   refused (the password change ends them all); only the new password logs
 *   in, and its session passes the admin gate; the accepted offer bound to
 *   the grant the second made and the declined offer declined; no invariant
 *   broken.
 *
 * Every phase drains the backend's detached writes before its teardown,
 * which holds the backend to exit `0` with no unexpected error in its log
 * (`spawn_backend`).
 *
 * **What the configs must share.** One Postgres database — each config's
 * `DATABASE_URL` env names `database_url`, compared as exact strings, so two
 * spellings of one database are refused — the session cookie name and a
 * `SECRET_FUZ_COOKIE_KEYS` both set: a cookie one spine signs, the other must
 * verify. A backend that resets its database at boot must have it off, or
 * it drops what the other wrote: `FUZ_TESTING_RESET_DB_ON_STARTUP` (the Rust
 * family's `reset_db_on_startup`) unset or a false stringbool, read as the
 * Rust spine reads it (`EnvStringbool`). Both mount `_testing_drain_effects`
 * and `_testing_db_invariants`, and `declined_role` is not `admin`. The
 * suite checks all of it first. Per-process state — rate limiters, socket
 * registries, the daemon token — is not carried over, by design.
 *
 * @module
 */

import { afterAll, afterEach, assert, beforeAll, describe, test } from 'vitest';
import { parse, type Schema } from '@fuzdev/fuz_schema/schema.ts';

import { TokenCreateOutput, TokenRevokeOutput } from '../../auth/account_action_specs.ts';
import { SessionAccountJson } from '../../auth/account_schema.ts';
import { InviteCreateOutput, InviteListOutput } from '../../auth/admin_action_specs.ts';
import { DAEMON_TOKEN_HEADER } from '../../auth/daemon_token.ts';
import {
	RoleGrantOfferAcceptOutput,
	RoleGrantOfferCreateOutput,
	RoleGrantOfferDeclineOutput,
	RoleGrantOfferHistoryOutput,
	RoleGrantOfferListOutput
} from '../../auth/role_grant_offer_action_specs.ts';
import { ROLE_ADMIN } from '../../auth/role_schema.ts';
import { create_db } from '../../db/create_db.ts';
import type { Db } from '../../db/db.ts';
import { EnvStringbool } from '../../env/env_schemas.ts';
import {
	ERROR_ALREADY_BOOTSTRAPPED,
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS,
	ERROR_INVALID_CREDENTIALS
} from '../../http/error_schemas.ts';
import { DbInvariantRows } from '../db_invariant_queries.ts';
import { assert_db_invariant_rows } from '../db_invariants.ts';
import { bootstrap } from '../transports/bootstrap.ts';
import { create_fetch_transport, type FetchTransport } from '../transports/fetch_transport.ts';
import type { BackendConfig } from './backend_config.ts';
import { cross_rpc_call, error_reason, expect_output, type RpcResult } from './cross_rpc.ts';
import { spawn_backend, type BackendHandle } from './spawn_backend.ts';
import {
	SPINE_ACCOUNT_LOGIN_PATH,
	SPINE_ACCOUNT_LOGOUT_PATH,
	SPINE_ACCOUNT_PASSWORD_PATH,
	SPINE_ACCOUNT_SIGNUP_PATH,
	SPINE_ACCOUNT_STATUS_PATH,
	SPINE_PARTICIPANT_ROLE
} from './spine_surface_constants.ts';

/** One order of the swap: `first` mints, `second` honors, `first` checks. */
export interface BackendSwapOrder {
	/** Names the order's `describe`. */
	readonly label: string;
	readonly first: BackendConfig;
	readonly second: BackendConfig;
}

/** Options for `describe_backend_swap_tests`. */
export interface BackendSwapTestOptions {
	/** The orders to run, one after another over the one database. */
	readonly orders: ReadonlyArray<BackendSwapOrder>;
	/**
	 * The `postgres://` database every config runs over, read directly for the
	 * snapshots — each config's `DATABASE_URL` env must be this exact string.
	 */
	readonly database_url: string;
	/**
	 * The role of the offer the second backend declines — one the keeper may
	 * offer, other than `admin` (the offer the second backend accepts; the
	 * suite refuses `admin`). Default `SPINE_PARTICIPANT_ROLE`, which the
	 * reference spines register.
	 */
	readonly declined_role?: string;
	/**
	 * Empty the database — each order calls it before its first spawn, so the
	 * keeper bootstrap finds no account. The caller owns the guard on which
	 * database it drops (`empty_owned_database`).
	 */
	readonly empty_database: () => Promise<void>;
}

/** The env var a backend's database URL rides in on both spine families. */
const DATABASE_URL_ENV = 'DATABASE_URL';

/** The cookie-signing keys env var both spine families read. */
const COOKIE_KEYS_ENV = 'SECRET_FUZ_COOKIE_KEYS';

/** The Rust family's startup-reset gate (`make_default_rust_backend_config`). */
const RESET_DB_ON_STARTUP_ENV = 'FUZ_TESTING_RESET_DB_ON_STARTUP';

/** The backdoors the suite drives. */
const SWAP_BACKDOORS = ['_testing_drain_effects', '_testing_db_invariants'] as const;

/** The member account the first backend signs up. */
const SWAP_MEMBER_USERNAME = 'swap_member';
const SWAP_PASSWORD = 'swap-password-before';
const SWAP_PASSWORD_CHANGED = 'swap-password-after';
const SWAP_PASSWORD_WRONG = 'swap-password-wrong';

/** What a phase may take past its backend's startup window (ms). */
const SWAP_PHASE_WORK_MS = 30_000;

/** One table's content: its row count and a digest of its rows as text, in order. */
interface SwapTableContent {
	readonly rows: number;
	readonly digest: string;
}

/**
 * The migrations a database holds (with when each was applied) and every
 * table's content — a row a boot rewrote in place changes its table's digest.
 */
interface SwapDbSnapshot {
	readonly schema_version: ReadonlyArray<Record<string, unknown>>;
	readonly tables: Readonly<Record<string, SwapTableContent>>;
}

/** What the first backend minted, carried to the second. */
interface SwapCredentials {
	readonly keeper_id: string;
	readonly keeper_cookies: ReadonlyArray<string>;
	/** A second keeper session, which the second backend logs out. */
	readonly keeper_spare_cookies: ReadonlyArray<string>;
	/** A keeper API token, which the second backend revokes. */
	readonly keeper_token: string;
	readonly keeper_token_id: string;
	readonly member_id: string;
	/** The `Set-Cookie` lines of the member's login on the first backend. */
	readonly member_cookies: ReadonlyArray<string>;
	readonly token: string;
	readonly token_id: string;
	/** The offer the second backend accepts. */
	readonly offer_accepted_id: string;
	/** The offer the second backend declines. */
	readonly offer_declined_id: string;
	readonly snapshot: SwapDbSnapshot;
}

/** What the second backend wrote, checked on the first again. */
interface SwapWrites {
	/** The `Set-Cookie` lines of the member's login on the second backend. */
	readonly member_cookies: ReadonlyArray<string>;
	readonly role_grant_id: string;
}

const read_snapshot = async (db: Db): Promise<SwapDbSnapshot> => {
	const schema_version = await db.query<Record<string, unknown>>(
		'SELECT namespace, name, sequence, applied_at::text AS applied_at FROM schema_version ' +
			'ORDER BY namespace, sequence'
	);
	const tables = await db.query<{ schemaname: string; tablename: string }>(
		'SELECT schemaname, tablename FROM pg_tables ' +
			"WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY schemaname, tablename"
	);
	const content: Record<string, SwapTableContent> = {};
	for (const { schemaname, tablename } of tables) {
		const [row] = await db.query<SwapTableContent>(
			'SELECT count(*)::int AS rows, ' +
				"md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text), '')) AS digest " +
				`FROM "${schemaname}"."${tablename}" t`
		);
		content[`${schemaname}.${tablename}`] = row!;
	}
	return { schema_version, tables: content };
};

/**
 * The backend a phase has running, held where an `afterEach` can reach it: a
 * phase that times out abandons its body, which never tears down, and the
 * next phase would find the port taken.
 */
interface LiveBackend {
	handle: BackendHandle | null;
}

/**
 * Spawn `config`, run `body`, then tear down — a teardown failure (an exit
 * other than `0`, an unexpected error in the log) fails the phase. A failed
 * body's teardown is logged beside the body's error rather than replacing it.
 * The handle sits in `live` while the backend runs.
 */
const with_backend = async <T>(
	config: BackendConfig,
	live: LiveBackend,
	body: (handle: BackendHandle) => Promise<T>
): Promise<T> => {
	const handle = await spawn_backend(config);
	live.handle = handle;
	let result: T;
	try {
		result = await body(handle);
	} catch (err) {
		live.handle = null;
		await handle.teardown().catch((teardown_error: unknown) => console.error(teardown_error));
		throw err;
	}
	live.handle = null;
	await handle.teardown();
	return result;
};

/** Tear down a backend a phase left running — one that timed out — logging a failed teardown. */
const teardown_left_running = async (live: LiveBackend): Promise<void> => {
	const { handle } = live;
	if (!handle) return;
	live.handle = null;
	await handle.teardown().catch((err: unknown) => console.error(err));
};

/** A transport on `config`'s backend, holding `cookies` when given. */
const transport_for = (
	config: BackendConfig,
	cookies?: ReadonlyArray<string>,
	origin?: null
): FetchTransport =>
	create_fetch_transport({
		base_url: config.base_url,
		...(cookies && { initial_cookies: cookies }),
		...(origin === null && { origin: null })
	});

const rpc = (
	config: BackendConfig,
	transport: FetchTransport,
	method: string,
	params: unknown,
	headers: Record<string, string> = {}
): Promise<RpcResult> => cross_rpc_call(transport, config.rpc_path, method, params, headers);

/** `method` on a fresh transport holding `cookies`, its output parsed. */
const rpc_as = async <T>(
	config: BackendConfig,
	cookies: ReadonlyArray<string>,
	method: string,
	params: unknown,
	output: Schema<T, any>
): Promise<T> =>
	expect_output(await rpc(config, transport_for(config, cookies), method, params), output);

/** A daemon-token backdoor call: Origin-free and cookie-free, as the daemon token requires. */
const backdoor = (handle: BackendHandle, method: string): Promise<RpcResult> =>
	rpc(handle.config, transport_for(handle.config, undefined, null), method, undefined, {
		[DAEMON_TOKEN_HEADER]: handle.daemon_token
	});

/** Await the backend's detached writes, so what the phase did is all on disk before teardown. */
const drain = async (handle: BackendHandle): Promise<void> => {
	const drained = await backdoor(handle, '_testing_drain_effects');
	assert.deepStrictEqual(drained.result, { ok: true }, `${handle.config.name}: the drain answers`);
};

const assert_invariants = async (handle: BackendHandle): Promise<void> => {
	const answer = expect_output(await backdoor(handle, '_testing_db_invariants'), DbInvariantRows);
	assert_db_invariant_rows(answer.rows, handle.config.name);
};

/** A JSON `POST` to a REST route: its status, body and `Set-Cookie` lines. */
const post_json = async (
	transport: FetchTransport,
	path: string,
	body: unknown
): Promise<{ status: number; body: unknown; set_cookies: Array<string> }> => {
	const res = await transport(path, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	const text = await res.text();
	return {
		status: res.status,
		body: text ? JSON.parse(text) : null,
		set_cookies: res.headers.getSetCookie()
	};
};

const login = (config: BackendConfig, password: string) =>
	post_json(transport_for(config), SPINE_ACCOUNT_LOGIN_PATH, {
		username: SWAP_MEMBER_USERNAME,
		password
	});

/** Who a credential authenticates as on `config`'s backend: an account id, or `null` on a 401. */
const verified_account_id = async (
	config: BackendConfig,
	credential: { cookies: ReadonlyArray<string> } | { bearer: string }
): Promise<string | null> => {
	const res =
		'cookies' in credential
			? await rpc(config, transport_for(config, credential.cookies), 'account_verify', undefined)
			: // Origin-free: a bearer beside an `Origin` is discarded as browser context
				await rpc(config, transport_for(config, undefined, null), 'account_verify', undefined, {
					authorization: `Bearer ${credential.bearer}`
				});
	if (res.status === 401) {
		assert.strictEqual(error_reason(res), ERROR_AUTHENTICATION_REQUIRED);
		return null;
	}
	return expect_output(res, SessionAccountJson).id;
};

/** The member's admin gate: `invite_list` answered (`true`) or refused 403 (`false`). */
const passes_admin_gate = async (
	config: BackendConfig,
	cookies: ReadonlyArray<string>
): Promise<boolean> => {
	const res = await rpc(config, transport_for(config, cookies), 'invite_list', undefined);
	if (res.status === 403) {
		assert.strictEqual(error_reason(res), ERROR_INSUFFICIENT_PERMISSIONS);
		return false;
	}
	expect_output(res, InviteListOutput);
	return true;
};

/** The first backend: bootstrap, then everything the second must honor. */
const mint_swap_credentials = async (
	handle: BackendHandle,
	db: Db,
	declined_role: string
): Promise<SwapCredentials> => {
	const { config } = handle;
	const keeper = await bootstrap({ transport: transport_for(config), config });
	const keeper_spare = await post_json(transport_for(config), SPINE_ACCOUNT_LOGIN_PATH, {
		username: config.bootstrap.username,
		password: config.bootstrap.password
	});
	assert.strictEqual(keeper_spare.status, 200, 'the keeper logs in again');
	assert.strictEqual(keeper_spare.set_cookies.length, 1, 'a login sets exactly the session cookie');
	const keeper_token = await rpc_as(
		config,
		keeper.cookies,
		'account_token_create',
		{ scope: { kind: 'full' }, lifetime: { kind: 'eternal' } },
		TokenCreateOutput
	);

	expect_output(
		await rpc(config, transport_for(config, keeper.cookies), 'invite_create', {
			username: SWAP_MEMBER_USERNAME
		}),
		InviteCreateOutput
	);
	const signup = await post_json(transport_for(config), SPINE_ACCOUNT_SIGNUP_PATH, {
		username: SWAP_MEMBER_USERNAME,
		password: SWAP_PASSWORD
	});
	assert.strictEqual(signup.status, 200, `signup: ${JSON.stringify(signup.body)}`);
	const member = signup.body as { account: { id: string }; actor: { id: string } };

	const logged_in = await login(config, SWAP_PASSWORD);
	assert.strictEqual(logged_in.status, 200, 'the member logs in');
	assert.strictEqual(logged_in.set_cookies.length, 1, 'a login sets exactly the session cookie');
	const member_cookies = logged_in.set_cookies;

	const token = await rpc_as(
		config,
		member_cookies,
		'account_token_create',
		{ scope: { kind: 'full' }, lifetime: { kind: 'eternal' } },
		TokenCreateOutput
	);

	const offer = async (params: object): Promise<string> =>
		(
			await rpc_as(
				config,
				keeper.cookies,
				'role_grant_offer_create',
				{ to_account_id: member.account.id, ...params },
				RoleGrantOfferCreateOutput
			)
		).offer.id;
	const offer_accepted_id = await offer({ role: ROLE_ADMIN });
	const offer_declined_id = await offer({ role: declined_role, to_actor_id: member.actor.id });

	const { offers } = await rpc_as(
		config,
		member_cookies,
		'role_grant_offer_list',
		undefined,
		RoleGrantOfferListOutput
	);
	assert.sameMembers(
		offers.map((o) => o.id),
		[offer_accepted_id, offer_declined_id]
	);

	await drain(handle);
	return {
		keeper_id: keeper.account.id,
		keeper_cookies: keeper.cookies,
		keeper_spare_cookies: keeper_spare.set_cookies,
		keeper_token: keeper_token.token,
		keeper_token_id: keeper_token.id,
		member_id: member.account.id,
		member_cookies,
		token: token.token,
		token_id: token.id,
		offer_accepted_id,
		offer_declined_id,
		snapshot: await read_snapshot(db)
	};
};

/** The second backend: honor everything the first minted, then write over it. */
const use_swap_credentials = async (
	handle: BackendHandle,
	db: Db,
	minted: SwapCredentials
): Promise<SwapWrites> => {
	const { config } = handle;

	// before any request but the health probe: nothing migrated, nothing written
	assert.deepStrictEqual(
		await read_snapshot(db),
		minted.snapshot,
		'the boot applied no migration and wrote or rewrote no row'
	);

	const status = await transport_for(config)(SPINE_ACCOUNT_STATUS_PATH, { method: 'GET' });
	const status_body = (await status.json()) as { bootstrap_available?: unknown };
	assert.strictEqual(status.status, 401, 'an anonymous status is refused');
	assert.notStrictEqual(status_body.bootstrap_available, true, 'bootstrap is closed');
	const rebootstrap = await post_json(transport_for(config), config.bootstrap_path, {
		token: config.bootstrap.token,
		username: config.bootstrap.username,
		password: config.bootstrap.password
	});
	assert.strictEqual(rebootstrap.status, 403, 'a second bootstrap is refused');
	assert.strictEqual((rebootstrap.body as { error?: unknown }).error, ERROR_ALREADY_BOOTSTRAPPED);

	assert.strictEqual(
		await verified_account_id(config, { cookies: minted.keeper_cookies }),
		minted.keeper_id,
		"the keeper's cookie authenticates"
	);
	assert.strictEqual(
		await verified_account_id(config, { cookies: minted.keeper_spare_cookies }),
		minted.keeper_id,
		"the keeper's second cookie authenticates"
	);
	assert.strictEqual(
		await verified_account_id(config, { bearer: minted.keeper_token }),
		minted.keeper_id,
		"the keeper's API token authenticates"
	);
	assert.strictEqual(
		await verified_account_id(config, { cookies: minted.member_cookies }),
		minted.member_id,
		"the member's cookie authenticates"
	);
	assert.strictEqual(
		await verified_account_id(config, { bearer: minted.token }),
		minted.member_id,
		"the member's API token authenticates"
	);

	const logged_in = await login(config, SWAP_PASSWORD);
	assert.strictEqual(logged_in.status, 200, "the other spine's password hash verifies");
	const member_cookies = logged_in.set_cookies;
	const wrong = await login(config, SWAP_PASSWORD_WRONG);
	assert.strictEqual(wrong.status, 401, 'a wrong password is refused');
	assert.strictEqual((wrong.body as { error?: unknown }).error, ERROR_INVALID_CREDENTIALS);

	const { offers } = await rpc_as(
		config,
		member_cookies,
		'role_grant_offer_list',
		undefined,
		RoleGrantOfferListOutput
	);
	assert.sameMembers(
		offers.filter((o) => o.accepted_at === null && o.declined_at === null).map((o) => o.id),
		[minted.offer_accepted_id, minted.offer_declined_id],
		'both offers are pending'
	);
	assert.isFalse(await passes_admin_gate(config, member_cookies), 'no admin before the accept');
	const declined = await rpc_as(
		config,
		member_cookies,
		'role_grant_offer_decline',
		{ offer_id: minted.offer_declined_id },
		RoleGrantOfferDeclineOutput
	);
	assert.isNotNull(declined.offer.declined_at);
	const accepted = await rpc_as(
		config,
		member_cookies,
		'role_grant_offer_accept',
		{ offer_id: minted.offer_accepted_id },
		RoleGrantOfferAcceptOutput
	);
	assert.isTrue(await passes_admin_gate(config, member_cookies), 'the accepted grant confers');

	await assert_invariants(handle);

	// the revocations of what the first spine minted: the keeper's, which
	// nothing else ends, and the member's password change, which ends every
	// session and token of the member's
	const logout = await post_json(
		transport_for(config, minted.keeper_spare_cookies),
		SPINE_ACCOUNT_LOGOUT_PATH,
		{}
	);
	assert.strictEqual(logout.status, 200, "the first spine's keeper session logs out");
	const revoked = await rpc_as(
		config,
		minted.keeper_cookies,
		'account_token_revoke',
		{ token_id: minted.keeper_token_id },
		TokenRevokeOutput
	);
	assert.isTrue(revoked.revoked, "the first spine's keeper token is revoked");
	assert.isNull(
		await verified_account_id(config, { cookies: minted.keeper_spare_cookies }),
		'the logged-out keeper session is refused'
	);
	assert.isNull(
		await verified_account_id(config, { bearer: minted.keeper_token }),
		'the revoked keeper token is refused'
	);
	const changed = await post_json(
		transport_for(config, member_cookies),
		SPINE_ACCOUNT_PASSWORD_PATH,
		{ current_password: SWAP_PASSWORD, new_password: SWAP_PASSWORD_CHANGED }
	);
	assert.strictEqual(changed.status, 200, `password change: ${JSON.stringify(changed.body)}`);

	await drain(handle);
	return { member_cookies, role_grant_id: accepted.role_grant_id };
};

/** The first backend again: what the second wrote holds. */
const check_swap_writes = async (
	handle: BackendHandle,
	db: Db,
	minted: SwapCredentials,
	written: SwapWrites
): Promise<void> => {
	const { config } = handle;
	assert.deepStrictEqual(
		(await read_snapshot(db)).schema_version,
		minted.snapshot.schema_version,
		'the migrations are as the first boot left them'
	);

	// the revocations the second spine wrote, which nothing else ended
	assert.isNull(
		await verified_account_id(config, { cookies: minted.keeper_spare_cookies }),
		'the keeper session the other spine logged out is refused'
	);
	assert.isNull(
		await verified_account_id(config, { bearer: minted.keeper_token }),
		'the keeper token the other spine revoked is refused'
	);
	assert.strictEqual(
		await verified_account_id(config, { cookies: minted.keeper_cookies }),
		minted.keeper_id,
		"the keeper's first cookie still authenticates"
	);
	// the other spine's password change ended every session and token of the member's
	assert.isNull(
		await verified_account_id(config, { cookies: minted.member_cookies }),
		"the password change ended the member's session on this spine"
	);
	assert.isNull(
		await verified_account_id(config, { cookies: written.member_cookies }),
		"the password change ended the member's session on the other spine"
	);
	assert.isNull(
		await verified_account_id(config, { bearer: minted.token }),
		"the password change ended the member's token"
	);

	const old_password = await login(config, SWAP_PASSWORD);
	assert.strictEqual(old_password.status, 401, 'the old password is refused');
	const new_password = await login(config, SWAP_PASSWORD_CHANGED);
	assert.strictEqual(new_password.status, 200, 'the new password logs in');
	assert.isTrue(
		await passes_admin_gate(config, new_password.set_cookies),
		'the grant the other spine made confers'
	);

	const { offers } = await rpc_as(
		config,
		minted.keeper_cookies,
		'role_grant_offer_history',
		{},
		RoleGrantOfferHistoryOutput
	);
	const accepted = offers.find((o) => o.id === minted.offer_accepted_id);
	const declined = offers.find((o) => o.id === minted.offer_declined_id);
	assert.ok(accepted && declined, "the keeper's history lists both offers");
	assert.isNotNull(accepted.accepted_at, 'the accepted offer is accepted');
	assert.strictEqual(accepted.resulting_role_grant_id, written.role_grant_id);
	assert.isNotNull(declined.declined_at, 'the declined offer is declined');
	assert.isNull(declined.accepted_at);

	await assert_invariants(handle);
	await drain(handle);
};

/**
 * Why a config's startup-reset env doesn't leave the reset off, or `null` when
 * it does — read as the Rust spine reads it: unset or a false stringbool is
 * off, a true one resets, and any other value fails its boot. A config that
 * leaves it out reads the harness process's own, which `spawn_backend` passes
 * to the child.
 */
const to_reset_problem = (config: BackendConfig): string | null => {
	const value = config.env[RESET_DB_ON_STARTUP_ENV] ?? process.env[RESET_DB_ON_STARTUP_ENV];
	if (value === undefined) return null;
	const parsed = parse(EnvStringbool, value);
	if (!parsed.ok) {
		return `${config.name}'s ${RESET_DB_ON_STARTUP_ENV} is no stringbool (${JSON.stringify(value)})`;
	}
	return parsed.value
		? `${config.name} resets its database at startup (${RESET_DB_ON_STARTUP_ENV})`
		: null;
};

/**
 * Throw naming each way `order`'s configs can't swap over `database_url`.
 * Database URLs compare as exact strings.
 */
const assert_swappable = (
	order: BackendSwapOrder,
	database_url: string,
	declined_role: string
): void => {
	const { first, second } = order;
	const problems: Array<string> = [];
	if (declined_role === ROLE_ADMIN) {
		problems.push(
			`declined_role is ${ROLE_ADMIN}, the accepted offer's role — a second offer of a ` +
				'role still pending answers the first, so the two offers would be one'
		);
	}
	if (first.cookie_name !== second.cookie_name) {
		problems.push(`cookie names differ (${first.cookie_name}, ${second.cookie_name})`);
	}
	if (first.env[COOKIE_KEYS_ENV] === undefined && second.env[COOKIE_KEYS_ENV] === undefined) {
		problems.push(`neither config sets ${COOKIE_KEYS_ENV}`);
	} else if (first.env[COOKIE_KEYS_ENV] !== second.env[COOKIE_KEYS_ENV]) {
		problems.push(`${COOKIE_KEYS_ENV} differs`);
	}
	for (const config of [first, second]) {
		const url = config.env[DATABASE_URL_ENV];
		if (url === undefined) {
			problems.push(`${config.name} sets no ${DATABASE_URL_ENV}`);
		} else if (url !== database_url) {
			problems.push(`${config.name}'s ${DATABASE_URL_ENV} is not the swap's database`);
		}
		const reset_problem = to_reset_problem(config);
		if (reset_problem !== null) problems.push(reset_problem);
		for (const method of SWAP_BACKDOORS) {
			if (!config.capabilities.testing_backdoors.includes(method)) {
				problems.push(`${config.name} doesn't declare ${method}`);
			}
		}
	}
	if (problems.length > 0) {
		throw new Error(`backend swap '${order.label}': ${problems.join('; ')}`);
	}
};

/**
 * Describe the backend swap over each order (§module doc): three tests per
 * order, run in turn, each phase spawning and stopping its own backend. A
 * phase whose predecessor failed fails naming it.
 *
 * @param options - the orders, the shared database, and how to empty it
 */
export const describe_backend_swap_tests = (options: BackendSwapTestOptions): void => {
	const { orders, database_url, empty_database, declined_role = SPINE_PARTICIPANT_ROLE } = options;

	describe('backend swap', () => {
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
			const timeout =
				Math.max(first.startup_timeout_ms, second.startup_timeout_ms) + SWAP_PHASE_WORK_MS;
			const state: { minted?: SwapCredentials; written?: SwapWrites } = {};
			const live: LiveBackend = { handle: null };

			describe(label, () => {
				afterEach(() => teardown_left_running(live));

				test(
					`${first.name} mints credentials over an empty database`,
					async () => {
						assert_swappable(order, database_url, declined_role);
						await empty_database();
						state.minted = await with_backend(first, live, (handle) =>
							mint_swap_credentials(handle, get_db(), declined_role)
						);
					},
					timeout
				);

				test(
					`${second.name} boots over them and honors each`,
					async () => {
						const { minted } = state;
						assert.ok(minted, `${first.name}'s mint phase did not complete`);
						state.written = await with_backend(second, live, (handle) =>
							use_swap_credentials(handle, get_db(), minted)
						);
					},
					timeout
				);

				test(
					`${first.name} boots again and honors what ${second.name} wrote`,
					async () => {
						const { minted, written } = state;
						assert.ok(minted && written, `${second.name}'s phase did not complete`);
						await with_backend(first, live, (handle) =>
							check_swap_writes(handle, get_db(), minted, written)
						);
					},
					timeout
				);
			});
		}
	});
};
