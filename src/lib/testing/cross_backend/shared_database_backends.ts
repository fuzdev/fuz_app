import '../assert_dev_env.ts';

/**
 * Helpers for suites that run several spines over one Postgres database —
 * the backend swap (`backend_swap.ts`, one backend at a time) and both spines
 * live (`backend_both_live.ts`, at once). They share what a credential and a
 * write need to carry from one spine to the other: the config checks, a
 * snapshot of every table's content, the drain and invariant backdoors, and
 * who a credential authenticates as on a given backend.
 *
 * @module
 */

import { assert } from 'vitest';
import { parse, type Schema } from '@fuzdev/fuz_schema/schema.ts';

import { SessionAccountJson } from '../../auth/account_schema.ts';
import { InviteListOutput } from '../../auth/admin_action_specs.ts';
import { DAEMON_TOKEN_HEADER } from '../../auth/daemon_token.ts';
import type { Db } from '../../db/db.ts';
import { EnvStringbool } from '../../env/env_schemas.ts';
import {
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS
} from '../../http/error_schemas.ts';
import { DbInvariantRows } from '../db_invariant_queries.ts';
import { assert_db_invariant_rows } from '../db_invariants.ts';
import { create_fetch_transport, type FetchTransport } from '../transports/fetch_transport.ts';
import type { BackendConfig } from './backend_config.ts';
import { cross_rpc_call, error_reason, expect_output, type RpcResult } from './cross_rpc.ts';
import { spawn_backend, type BackendHandle } from './spawn_backend.ts';

/** The env var a backend's database URL rides in on both spine families. */
const DATABASE_URL_ENV = 'DATABASE_URL';

/** The cookie-signing keys env var both spine families read. */
const COOKIE_KEYS_ENV = 'SECRET_FUZ_COOKIE_KEYS';

/** The Rust family's startup-reset gate (`make_default_rust_backend_config`). */
const RESET_DB_ON_STARTUP_ENV = 'FUZ_TESTING_RESET_DB_ON_STARTUP';

/** The backdoors every shared-database suite drives: the drain and the invariants. */
export const SHARED_DATABASE_BACKDOORS = [
	'_testing_drain_effects',
	'_testing_db_invariants'
] as const;

/**
 * One order of a shared-database suite: the two configs it runs over the one
 * database, `first` before `second` — the backend swap
 * (`describe_backend_swap_tests`) and both spines live
 * (`describe_backend_both_live_tests`) each say what each side does.
 */
export interface SharedDatabaseOrder {
	/** Names the order's `describe`. */
	readonly label: string;
	readonly first: BackendConfig;
	readonly second: BackendConfig;
}

/** One table's content: its row count and a digest of its rows as text, in order. */
export interface SharedDatabaseTableContent {
	readonly rows: number;
	readonly digest: string;
}

/**
 * The migrations a database holds (with when each was applied) and every
 * table's content, keyed `schema.table` — a row written, deleted or rewritten
 * in place changes its table's digest.
 */
export interface SharedDatabaseSnapshot {
	readonly schema_version: ReadonlyArray<Record<string, unknown>>;
	readonly tables: Readonly<Record<string, SharedDatabaseTableContent>>;
}

/**
 * Read the migrations and every table's content over `db`. Read it after the
 * backends' drains (`drain_backend_effects`), or a detached write may land
 * after it.
 *
 * @param db - a direct connection to the shared database
 * @returns the snapshot
 */
export const read_shared_database_snapshot = async (db: Db): Promise<SharedDatabaseSnapshot> => {
	const schema_version = await db.query<Record<string, unknown>>(
		'SELECT namespace, name, sequence, applied_at::text AS applied_at FROM schema_version ' +
			'ORDER BY namespace, sequence'
	);
	const tables = await db.query<{ schemaname: string; tablename: string }>(
		'SELECT schemaname, tablename FROM pg_tables ' +
			"WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY schemaname, tablename"
	);
	const content: Record<string, SharedDatabaseTableContent> = {};
	for (const { schemaname, tablename } of tables) {
		const [row] = await db.query<SharedDatabaseTableContent>(
			'SELECT count(*)::int AS rows, ' +
				"md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text), '')) AS digest " +
				`FROM "${schemaname}"."${tablename}" t`
		);
		content[`${schemaname}.${tablename}`] = row!;
	}
	return { schema_version, tables: content };
};

/**
 * The tables whose content differs between two snapshots, sorted — a table
 * present in only one counts as changed.
 *
 * @param before - the earlier snapshot
 * @param after - the later snapshot
 * @returns the changed tables' `schema.table` keys
 */
export const to_changed_tables = (
	before: SharedDatabaseSnapshot,
	after: SharedDatabaseSnapshot
): Array<string> => {
	const names = new Set([...Object.keys(before.tables), ...Object.keys(after.tables)]);
	return [...names]
		.filter((name) => before.tables[name]?.digest !== after.tables[name]?.digest)
		.sort();
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
 * Each way `configs` can't share `database_url`: they must name it in
 * `DATABASE_URL` (compared as exact strings, so two spellings of one database
 * are refused), share the session cookie name and a set
 * `SECRET_FUZ_COOKIE_KEYS` (a cookie one spine signs, another must verify),
 * keep a startup reset off (`FUZ_TESTING_RESET_DB_ON_STARTUP` unset or a false
 * stringbool, as the Rust spine parses it), and declare the
 * `SHARED_DATABASE_BACKDOORS`.
 *
 * @param configs - the backends that run over the database
 * @param database_url - the `postgres://` database they share
 * @returns the problems, empty when they can share it
 */
export const to_shared_database_problems = (
	configs: ReadonlyArray<BackendConfig>,
	database_url: string
): Array<string> => {
	const problems: Array<string> = [];
	const cookie_names = new Set(configs.map((config) => config.cookie_name));
	if (cookie_names.size > 1) {
		problems.push(`cookie names differ (${[...cookie_names].join(', ')})`);
	}
	const cookie_keys = configs.map((config) => config.env[COOKIE_KEYS_ENV]);
	if (cookie_keys.every((keys) => keys === undefined)) {
		problems.push(`no config sets ${COOKIE_KEYS_ENV}`);
	} else if (new Set(cookie_keys).size > 1) {
		problems.push(`${COOKIE_KEYS_ENV} differs`);
	}
	for (const config of configs) {
		const url = config.env[DATABASE_URL_ENV];
		if (url === undefined) {
			problems.push(`${config.name} sets no ${DATABASE_URL_ENV}`);
		} else if (url !== database_url) {
			problems.push(`${config.name}'s ${DATABASE_URL_ENV} is not the shared database`);
		}
		const reset_problem = to_reset_problem(config);
		if (reset_problem !== null) problems.push(reset_problem);
		for (const method of SHARED_DATABASE_BACKDOORS) {
			if (!config.capabilities.testing_backdoors.includes(method)) {
				problems.push(`${config.name} doesn't declare ${method}`);
			}
		}
	}
	return problems;
};

/**
 * A spawned backend, held where an `afterEach` or `afterAll` can reach it: a
 * test that times out abandons its body, which never tears down, and the next
 * spawn would find the port taken.
 */
export interface LiveBackend {
	handle: BackendHandle | null;
}

/**
 * Spawn `config`, run `body`, then tear down — a teardown failure (an exit
 * other than `0`, an unexpected error in the log) fails the caller. A failed
 * body's teardown is logged beside the body's error rather than replacing it.
 * The handle sits in `live` while the backend runs.
 *
 * @param config - the backend to spawn
 * @param live - where the running handle is held
 * @param body - what to run against it
 * @returns what `body` returned
 */
export const with_live_backend = async <T>(
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

/**
 * Tear down a backend left running — one whose test timed out — logging a
 * failed teardown rather than throwing.
 *
 * @param live - the holder, cleared
 */
export const teardown_live_backend = async (live: LiveBackend): Promise<void> => {
	const { handle } = live;
	if (!handle) return;
	live.handle = null;
	await handle.teardown().catch((err: unknown) => console.error(err));
};

/**
 * A transport on `config`'s backend, holding `cookies` when given. `origin:
 * null` sends no `Origin`, as a bearer or daemon token requires.
 *
 * @param config - the backend
 * @param cookies - `Set-Cookie` lines to start the jar with
 * @param origin - `null` for an Origin-free transport
 * @returns the transport
 */
export const backend_transport = (
	config: BackendConfig,
	cookies?: ReadonlyArray<string>,
	origin?: null
): FetchTransport =>
	create_fetch_transport({
		base_url: config.base_url,
		...(cookies && { initial_cookies: cookies }),
		...(origin === null && { origin: null })
	});

/**
 * `method` on `config`'s RPC endpoint over `transport`.
 *
 * @param config - the backend
 * @param transport - the transport carrying the credential
 * @param method - the RPC method
 * @param params - its params
 * @param headers - extra request headers
 * @returns the answer
 */
export const backend_rpc = (
	config: BackendConfig,
	transport: FetchTransport,
	method: string,
	params: unknown,
	headers: Record<string, string> = {}
): Promise<RpcResult> => cross_rpc_call(transport, config.rpc_path, method, params, headers);

/**
 * `method` on a fresh transport holding `cookies`, its output parsed.
 *
 * @param config - the backend
 * @param cookies - the session's `Set-Cookie` lines
 * @param method - the RPC method
 * @param params - its params
 * @param output - the output schema it must answer
 * @returns the parsed output
 */
export const backend_rpc_as = async <T>(
	config: BackendConfig,
	cookies: ReadonlyArray<string>,
	method: string,
	params: unknown,
	output: Schema<T, any>
): Promise<T> =>
	expect_output(
		await backend_rpc(config, backend_transport(config, cookies), method, params),
		output
	);

/**
 * A daemon-token backdoor call: Origin-free and cookie-free, as the daemon
 * token requires.
 *
 * @param handle - the backend, whose daemon token authenticates
 * @param method - the backdoor method
 * @returns the answer
 */
export const backend_daemon_rpc = (handle: BackendHandle, method: string): Promise<RpcResult> =>
	backend_rpc(handle.config, backend_transport(handle.config, undefined, null), method, undefined, {
		[DAEMON_TOKEN_HEADER]: handle.daemon_token
	});

/**
 * Await the backend's detached writes (`_testing_drain_effects`), so what it
 * did is all on disk before a snapshot or teardown.
 *
 * @param handle - the backend
 */
export const drain_backend_effects = async (handle: BackendHandle): Promise<void> => {
	const drained = await backend_daemon_rpc(handle, '_testing_drain_effects');
	assert.deepStrictEqual(drained.result, { ok: true }, `${handle.config.name}: the drain answers`);
};

/**
 * Assert no database invariant is broken, as `handle`'s backend reads them
 * (`_testing_db_invariants`).
 *
 * @param handle - the backend
 */
export const assert_backend_invariants = async (handle: BackendHandle): Promise<void> => {
	const answer = expect_output(
		await backend_daemon_rpc(handle, '_testing_db_invariants'),
		DbInvariantRows
	);
	assert_db_invariant_rows(answer.rows, handle.config.name);
};

/** A REST answer: its status, parsed body (`null` when empty) and `Set-Cookie` lines. */
export interface BackendJsonAnswer {
	readonly status: number;
	readonly body: unknown;
	readonly set_cookies: Array<string>;
}

/**
 * A JSON `POST` to a REST route.
 *
 * @param transport - the transport carrying the credential
 * @param path - the route path
 * @param body - the JSON body
 * @returns the answer
 */
export const backend_post_json = async (
	transport: FetchTransport,
	path: string,
	body: unknown
): Promise<BackendJsonAnswer> => {
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

/**
 * Who a credential authenticates as on `config`'s backend (`account_verify`):
 * an account id, or `null` on a 401 `authentication_required`.
 *
 * @param config - the backend
 * @param credential - a session's `Set-Cookie` lines or a bearer token
 * @returns the account id, or `null` when refused
 */
export const verified_account_id = async (
	config: BackendConfig,
	credential: { cookies: ReadonlyArray<string> } | { bearer: string }
): Promise<string | null> => {
	const res =
		'cookies' in credential
			? await backend_rpc(
					config,
					backend_transport(config, credential.cookies),
					'account_verify',
					undefined
				)
			: // Origin-free: a bearer beside an `Origin` is discarded as browser context
				await backend_rpc(
					config,
					backend_transport(config, undefined, null),
					'account_verify',
					undefined,
					{ authorization: `Bearer ${credential.bearer}` }
				);
	if (res.status === 401) {
		assert.strictEqual(error_reason(res), ERROR_AUTHENTICATION_REQUIRED);
		return null;
	}
	return expect_output(res, SessionAccountJson).id;
};

/**
 * Whether a session passes the admin gate: `invite_list` answered (`true`) or
 * refused 403 `insufficient_permissions` (`false`).
 *
 * @param config - the backend
 * @param cookies - the session's `Set-Cookie` lines
 * @returns whether the gate passes
 */
export const passes_admin_gate = async (
	config: BackendConfig,
	cookies: ReadonlyArray<string>
): Promise<boolean> => {
	const res = await backend_rpc(
		config,
		backend_transport(config, cookies),
		'invite_list',
		undefined
	);
	if (res.status === 403) {
		assert.strictEqual(error_reason(res), ERROR_INSUFFICIENT_PERMISSIONS);
		return false;
	}
	expect_output(res, InviteListOutput);
	return true;
};
