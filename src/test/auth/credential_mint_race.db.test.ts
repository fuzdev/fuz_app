/**
 * A credential minted while the account's authorization state changes under
 * it: a login or an `account_token_create` racing a password change or an
 * account delete.
 *
 * The race is made exact, not hammered. A login is held inside its password
 * verify (a latched `PasswordHashDeps`) while the change or the delete runs to
 * completion, then released: it must be refused exactly as a wrong password
 * is, with no session row and no cookie. A token create is held before its
 * transaction begins (`hold_begin`) while a delete commits. The mirror order —
 * the mint commits first — ends with the credential revoked. Those run on
 * every driver: nothing is held inside a transaction.
 *
 * The lock is shown to serialize on real `pg` only (`TEST_DATABASE_URL`): a
 * mint waits on an uncommitted change's row lock, and a change waits on an
 * uncommitted mint's — so the change's revoke, which runs after its account
 * write, reaches the session the mint inserted. The in-memory drivers have one
 * connection, so the second transaction would queue behind the held one
 * whatever it locks.
 *
 * Also here: a session or API token on a tombstoned account, seeded directly,
 * authenticates nothing — the anonymous caller's 401, as on the Rust spine.
 *
 * A token create is authorized by a session resolved before its transaction;
 * the mint re-checks that session after taking the account lock, so a change
 * that committed first is seen revoking it, and one still to commit waits on
 * the lock and then revokes the token. A token outlives a later logout of the
 * session that minted it, as it always has.
 *
 * Twin of the Rust `fuz_auth` `tests/credential_mint_race.rs`.
 *
 * @module
 */

import { assert, test } from 'vitest';
import { wait } from '@fuzdev/fuz_util/async.ts';

import { create_test_app, stub_password_deps, type TestApp } from '#lib/testing/app_server.ts';
import { TEST_ORIGIN } from '#lib/testing/test_origin.ts';
import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_account_route_specs } from '#lib/auth/account_routes.ts';
import { create_standard_rpc_actions } from '#lib/auth/standard_rpc_actions.ts';
import { create_rpc_endpoint } from '#lib/actions/action_rpc.ts';
import { prefix_route_specs, type RouteSpec } from '#lib/http/route_spec.ts';
import { query_account_soft_delete } from '#lib/auth/account_queries.ts';
import { query_audit_log_list } from '#lib/auth/audit_log_queries.ts';
import { rpc_call } from '#lib/testing/rpc_helpers.ts';
import { install_audit_drift_guard } from '#lib/testing/audit_drift_guard.ts';
import {
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INVALID_CREDENTIALS
} from '#lib/http/error_schemas.ts';
import { ROLE_ADMIN } from '#lib/auth/role_schema.ts';
import { create_describe_db, auth_integration_truncate_tables } from '#lib/testing/db.ts';
import type { PasswordHashDeps } from '#lib/auth/password.ts';
import type { AppServerContext } from '#lib/server/app_server_context.ts';
import type { Db } from '#lib/db/db.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';

import { describe_db, pg_factory } from '../db_fixture.ts';
import { create_gated_db, type GatedDb } from '../gated_db.ts';

const session_options = create_session_config('test_session');
const RPC_PATH = '/api/rpc';
const OLD_PASSWORD = 'old-password-race-1';
const NEW_PASSWORD = 'new-password-race-2';

/** How long a blocked request is given to show it is blocked. */
const HOLD_MS = 300;

const json_headers = { 'content-type': 'application/json', host: 'localhost', origin: TEST_ORIGIN };

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
	...prefix_route_specs(
		'/api/account',
		create_account_route_specs(ctx.deps, {
			session_options,
			login_ip_rate_limiter: null,
			login_account_rate_limiter: null,
			login_fail_floor_ms: 0
		})
	),
	...create_rpc_endpoint({
		action_ip_rate_limiter: null,
		action_account_rate_limiter: null,
		path: RPC_PATH,
		actions: create_standard_rpc_actions(ctx.deps),
		log: ctx.deps.log
	})
];

/**
 * `stub_password_deps` whose next `verify_password` after `hold()` waits until
 * the test releases it — the window between a login's verify and its session
 * insert, made exact.
 */
const create_latched_password = () => {
	let latch: { reached: () => void; released: Promise<void> } | null = null;
	const deps: PasswordHashDeps = {
		...stub_password_deps,
		verify_password: async (password, password_hash) => {
			const held = latch;
			latch = null;
			if (held) {
				held.reached();
				await held.released;
			}
			return stub_password_deps.verify_password(password, password_hash);
		}
	};
	const hold = (): { reached: Promise<void>; release: () => void } => {
		const reached = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		latch = { reached: reached.resolve, released: released.promise };
		return { reached: reached.promise, release: released.resolve };
	};
	return { deps, hold };
};

interface Setup {
	test_app: TestApp;
	hold: () => { reached: Promise<void>; release: () => void };
	victim_id: Uuid;
	admin_headers: () => Record<string, string>;
}

const setup = async (db: Db): Promise<Setup> => {
	const latched = create_latched_password();
	const test_app = await create_test_app({
		session_options,
		db,
		password: latched.deps,
		create_route_specs
	});
	const admin = await test_app.create_account({ username: 'race_admin', roles: [ROLE_ADMIN] });
	const victim = await test_app.create_account({
		username: 'victim',
		password_value: OLD_PASSWORD
	});
	return {
		test_app,
		hold: latched.hold,
		victim_id: victim.account.id,
		admin_headers: () => admin.create_session_headers()
	};
};

const login = (test_app: TestApp, password: string) =>
	Promise.resolve(
		test_app.app.request('/api/account/login', {
			method: 'POST',
			headers: json_headers,
			body: JSON.stringify({ username: 'victim', password })
		})
	);

const cookie_of = (response: Response): string => {
	const line = response.headers.get('set-cookie');
	assert.ok(line, 'the login set a cookie');
	return line.split(';')[0]!;
};

const change_password = (test_app: TestApp, cookie: string) =>
	Promise.resolve(
		test_app.app.request('/api/account/password', {
			method: 'POST',
			headers: { ...json_headers, cookie },
			body: JSON.stringify({ current_password: OLD_PASSWORD, new_password: NEW_PASSWORD })
		})
	);

const admin_action = async (s: Setup, method: string) => {
	const result = await rpc_call({
		app: s.test_app.app,
		path: RPC_PATH,
		method,
		params: { account_id: s.victim_id },
		headers: s.admin_headers()
	});
	assert.ok(result.ok, `${method} succeeds`);
};

const token_create = (s: Setup, cookie: string) =>
	rpc_call({
		app: s.test_app.app,
		path: RPC_PATH,
		method: 'account_token_create',
		params: { name: 'race', scope: { kind: 'full' }, lifetime: { kind: 'eternal' } },
		headers: { cookie }
	});

const count_rows = async (s: Setup, table: 'auth_session' | 'api_token'): Promise<number> => {
	const rows = await s.test_app.backend.deps.db.query<{ count: number | string }>(
		`SELECT COUNT(*) AS count FROM ${table} WHERE account_id = $1`,
		[s.victim_id]
	);
	return Number(rows[0]!.count);
};

const count_failed_logins = async (s: Setup): Promise<number> => {
	const rows = await query_audit_log_list(
		{ db: s.test_app.backend.deps.db },
		{ event_type: 'login', outcome: 'failure', account_id: s.victim_id }
	);
	return rows.length;
};

const assert_refused_as_wrong_password = async (response: Response, label: string) => {
	assert.strictEqual(response.status, 401, label);
	assert.deepStrictEqual(await response.json(), { error: ERROR_INVALID_CREDENTIALS }, label);
	assert.strictEqual(response.headers.get('set-cookie'), null, `${label}: no cookie is set`);
};

const assert_unauthenticated = (
	result: Awaited<ReturnType<typeof rpc_call>>,
	label: string
): void => {
	assert.strictEqual(result.status, 401, label);
	assert.ok(!result.ok, label);
	assert.deepStrictEqual(result.error.data, { reason: ERROR_AUTHENTICATION_REQUIRED }, label);
};

describe_db('credential mint race', (get_db) => {
	install_audit_drift_guard();

	test('a login held across a password change is refused as a wrong password', async () => {
		const s = await setup(get_db());
		try {
			const first = await login(s.test_app, OLD_PASSWORD);
			assert.strictEqual(first.status, 200);
			await assert_refused_as_wrong_password(
				await login(s.test_app, 'not-the-password'),
				'the control: a wrong password'
			);
			const failures_before = await count_failed_logins(s);

			const held = s.hold();
			const raced = login(s.test_app, OLD_PASSWORD);
			await held.reached;
			const change = await change_password(s.test_app, cookie_of(first));
			assert.strictEqual(change.status, 200);
			held.release();

			await assert_refused_as_wrong_password(await raced, 'the login verified before the change');
			assert.strictEqual(await count_rows(s, 'auth_session'), 0, 'no session row survives');
			assert.strictEqual(
				await count_failed_logins(s),
				failures_before + 1,
				'audited as a failed login, as the wrong password was'
			);
			assert.strictEqual((await login(s.test_app, NEW_PASSWORD)).status, 200);
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('a login held across a delete is refused, and the undelete restores nothing', async () => {
		const s = await setup(get_db());
		try {
			const held = s.hold();
			const raced = login(s.test_app, OLD_PASSWORD);
			await held.reached;
			await admin_action(s, 'account_delete');
			held.release();

			await assert_refused_as_wrong_password(await raced, 'the login verified before the delete');
			assert.strictEqual(await count_rows(s, 'auth_session'), 0, 'no session row');
			await admin_action(s, 'account_undelete');
			assert.strictEqual(await count_rows(s, 'auth_session'), 0, 'the undelete restores none');
			assert.strictEqual((await login(s.test_app, OLD_PASSWORD)).status, 200);
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('a login committed before a password change is revoked by it', async () => {
		const s = await setup(get_db());
		try {
			const first = await login(s.test_app, OLD_PASSWORD);
			const second = await login(s.test_app, OLD_PASSWORD);
			assert.strictEqual(second.status, 200);
			const change = await change_password(s.test_app, cookie_of(first));
			assert.strictEqual(change.status, 200);
			assert.strictEqual((await change.json()).sessions_revoked, 3, 'the seeded and both logins');
			assert.strictEqual(await count_rows(s, 'auth_session'), 0);
			assert_unauthenticated(
				await rpc_call({
					app: s.test_app.app,
					path: RPC_PATH,
					method: 'account_verify',
					headers: { cookie: cookie_of(second) }
				}),
				"the second login's session"
			);
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('a login committed before a delete stays dead after the undelete', async () => {
		const s = await setup(get_db());
		try {
			const first = await login(s.test_app, OLD_PASSWORD);
			assert.strictEqual(first.status, 200);
			await admin_action(s, 'account_delete');
			await admin_action(s, 'account_undelete');
			assert.strictEqual(await count_rows(s, 'auth_session'), 0);
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('a token create authorized before a delete mints nothing after it', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated.db);
		try {
			const cookie = cookie_of(await login(s.test_app, OLD_PASSWORD));
			// the session and the account are read; the mint's transaction waits
			const held = gated.hold_begin();
			const raced = token_create(s, cookie);
			await held.reached;
			await admin_action(s, 'account_delete');
			held.release();

			assert_unauthenticated(await raced, 'the mint after the delete');
			await admin_action(s, 'account_undelete');
			assert.strictEqual(await count_rows(s, 'api_token'), 0, 'no token row');
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('a token committed before a delete is revoked by it', async () => {
		const s = await setup(get_db());
		try {
			const cookie = cookie_of(await login(s.test_app, OLD_PASSWORD));
			assert.ok((await token_create(s, cookie)).ok);
			await admin_action(s, 'account_delete');
			await admin_action(s, 'account_undelete');
			assert.strictEqual(await count_rows(s, 'api_token'), 0);
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('a token create authorized before a password change mints nothing after it', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated.db);
		try {
			const changer = cookie_of(await login(s.test_app, OLD_PASSWORD));
			const minter = cookie_of(await login(s.test_app, OLD_PASSWORD));
			// the session and the account are read; the mint's transaction waits
			const held = gated.hold_begin();
			const raced = token_create(s, minter);
			await held.reached;
			assert.strictEqual((await change_password(s.test_app, changer)).status, 200);
			held.release();

			assert_unauthenticated(await raced, 'the mint after the change');
			assert.strictEqual(await count_rows(s, 'api_token'), 0, 'no token row');
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('a token committed before a password change is revoked by it', async () => {
		const s = await setup(get_db());
		try {
			const changer = cookie_of(await login(s.test_app, OLD_PASSWORD));
			const minter = cookie_of(await login(s.test_app, OLD_PASSWORD));
			assert.ok((await token_create(s, minter)).ok);
			const change = await change_password(s.test_app, changer);
			assert.strictEqual(change.status, 200);
			assert.strictEqual((await change.json()).tokens_revoked, 2, 'the seeded token and the mint');
			assert.strictEqual(await count_rows(s, 'api_token'), 0);
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('a token minted by a session that is later logged out keeps working', async () => {
		const s = await setup(get_db());
		try {
			const cookie = cookie_of(await login(s.test_app, OLD_PASSWORD));
			const minted = await token_create(s, cookie);
			assert.ok(minted.ok);
			const token = (minted.result as { token: string }).token;
			const logout = await s.test_app.app.request('/api/account/logout', {
				method: 'POST',
				headers: { ...json_headers, cookie }
			});
			assert.strictEqual(logout.status, 200);
			const verified = await s.test_app.app.request(RPC_PATH, {
				method: 'POST',
				headers: {
					host: 'localhost',
					'content-type': 'application/json',
					authorization: `Bearer ${token}`
				},
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'account_verify' })
			});
			assert.strictEqual(verified.status, 200, 'the token outlives the session that minted it');
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('a session or token on a tombstoned account is the anonymous caller', async () => {
		const s = await setup(get_db());
		try {
			const cookie = cookie_of(await login(s.test_app, OLD_PASSWORD));
			const token_result = await token_create(s, cookie);
			assert.ok(token_result.ok);
			const token = (token_result.result as { token: string }).token;
			// the tombstone alone, the credential rows left in place
			await query_account_soft_delete({ db: s.test_app.backend.deps.db }, s.victim_id, null);
			assert.strictEqual(await count_rows(s, 'auth_session'), 2, 'the seeded rows stand');

			// no `Origin`, so the bearer is not discarded as browser context
			const verify = async (headers: Record<string, string>) => {
				const response = await s.test_app.app.request(RPC_PATH, {
					method: 'POST',
					headers: { host: 'localhost', 'content-type': 'application/json', ...headers },
					body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'account_verify' })
				});
				return { status: response.status, body: await response.json() };
			};
			const anonymous = await verify({});
			assert.strictEqual(anonymous.status, 401);
			assert.deepStrictEqual(anonymous.body.error.data, { reason: ERROR_AUTHENTICATION_REQUIRED });
			for (const [label, headers] of [
				['session', { cookie }],
				['token', { authorization: `Bearer ${token}` }]
			] as const) {
				assert.deepStrictEqual(
					await verify(headers),
					anonymous,
					`${label}: byte-identical to the anonymous refusal`
				);
			}
			const used = await s.test_app.backend.deps.db.query<{ last_used_at: unknown }>(
				`SELECT last_used_at FROM api_token WHERE account_id = $1 AND name = 'race'`,
				[s.victim_id]
			);
			assert.deepStrictEqual(used, [{ last_used_at: null }], 'the refused token records no use');
		} finally {
			await s.test_app.cleanup();
		}
	});
});

const describe_pg = create_describe_db(pg_factory, auth_integration_truncate_tables);

/**
 * Start `blocked` while `gated` holds a transaction at its commit, wait until
 * `blocked` has opened its own transaction and is still unsettled after
 * `HOLD_MS`, then release the commit.
 */
const assert_waits_on_held_commit = async (
	gated: GatedDb,
	held: { release: () => void },
	blocked: Promise<Response | Awaited<ReturnType<typeof rpc_call>>>
): Promise<void> => {
	let settled = false;
	const settle = () => {
		settled = true;
	};
	blocked.then(settle, settle);
	try {
		const deadline = Date.now() + 2000;
		while (gated.open_transactions() < 2) {
			assert.ok(!settled, 'settled without opening its transaction');
			assert.ok(Date.now() < deadline, 'opened no transaction within 2s');
			await wait(5);
		}
		await wait(HOLD_MS);
		assert.ok(!settled, 'waits on the held transaction');
	} finally {
		// released on a failure too, so no later test waits on its row lock
		held.release();
	}
};

describe_pg('credential mint race: the lock serializes', (get_db) => {
	install_audit_drift_guard();

	test('a login waits on an uncommitted password change, then is refused', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated.db);
		try {
			const first = await login(s.test_app, OLD_PASSWORD);
			const held = gated.hold_commit();
			const change = change_password(s.test_app, cookie_of(first));
			await held.reached;
			const raced = login(s.test_app, OLD_PASSWORD);
			await assert_waits_on_held_commit(gated, held, raced);
			assert.strictEqual((await change).status, 200);
			await assert_refused_as_wrong_password(await raced, 'the login that waited');
			assert.strictEqual(await count_rows(s, 'auth_session'), 0);
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('a password change waits on an uncommitted login, then revokes it', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated.db);
		try {
			const first = await login(s.test_app, OLD_PASSWORD);
			const held = gated.hold_commit();
			const raced = login(s.test_app, OLD_PASSWORD);
			await held.reached;
			const change = change_password(s.test_app, cookie_of(first));
			await assert_waits_on_held_commit(gated, held, change);
			assert.strictEqual((await raced).status, 200);
			assert.strictEqual((await change).status, 200);
			assert.strictEqual(
				await count_rows(s, 'auth_session'),
				0,
				"the change's revoke, after its account write, reaches the minted session"
			);
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('a delete waits on an uncommitted login, then revokes it', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated.db);
		try {
			const held = gated.hold_commit();
			const raced = login(s.test_app, OLD_PASSWORD);
			await held.reached;
			const deleted = rpc_call({
				app: s.test_app.app,
				path: RPC_PATH,
				method: 'account_delete',
				params: { account_id: s.victim_id },
				headers: s.admin_headers()
			});
			await assert_waits_on_held_commit(gated, held, deleted);
			assert.strictEqual((await raced).status, 200);
			assert.ok((await deleted).ok);
			assert.strictEqual(
				await count_rows(s, 'auth_session'),
				0,
				"the delete's revoke, after its tombstone, reaches the minted session"
			);
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('a token create waits on an uncommitted password change, then is refused', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated.db);
		try {
			const changer = cookie_of(await login(s.test_app, OLD_PASSWORD));
			const minter = cookie_of(await login(s.test_app, OLD_PASSWORD));
			const held = gated.hold_commit();
			const change = change_password(s.test_app, changer);
			await held.reached;
			const raced = token_create(s, minter);
			await assert_waits_on_held_commit(gated, held, raced);
			assert.strictEqual((await change).status, 200);
			assert_unauthenticated(await raced, 'the mint that waited, its session revoked');
			assert.strictEqual(await count_rows(s, 'api_token'), 0);
		} finally {
			await s.test_app.cleanup();
		}
	});

	test('a token create waits on an uncommitted delete, then is refused', async () => {
		const gated = create_gated_db(get_db());
		const s = await setup(gated.db);
		try {
			const cookie = cookie_of(await login(s.test_app, OLD_PASSWORD));
			const held = gated.hold_commit();
			const deleted = rpc_call({
				app: s.test_app.app,
				path: RPC_PATH,
				method: 'account_delete',
				params: { account_id: s.victim_id },
				headers: s.admin_headers()
			});
			await held.reached;
			const raced = token_create(s, cookie);
			await assert_waits_on_held_commit(gated, held, raced);
			assert.ok((await deleted).ok);
			assert_unauthenticated(await raced, 'the mint that waited');
			assert.strictEqual(await count_rows(s, 'api_token'), 0);
		} finally {
			await s.test_app.cleanup();
		}
	});
});
