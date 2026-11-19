import '../assert_dev_env.ts';

/**
 * The credential conformance table over raw sockets: each row's header lines
 * sent to the live backend as they are written, and the real outcome asserted
 * — which credential authenticated the request, and whether the response
 * clears the session cookie.
 *
 * Where `credential_conformance.ts` asks a backend how it *reads* the lines
 * (through its credential-read backdoor), this sends them: the runtime's HTTP
 * parser, its joining of repeated lines, and the whole middleware chain sit
 * between the bytes and the answer. It is what proves a repeated
 * `Authorization` line authenticates nothing on a WebSocket upgrade, that a
 * non-ASCII byte in a sibling cookie hides nothing, and that the clear is on
 * the wire with the exact string. It needs no backdoor of its own, so it runs
 * on a backend that doesn't mount that backdoor.
 *
 * **Which credential authenticated** is read from `account_verify`, which
 * answers the calling account: the session cookie, the API token and the
 * daemon token each belong to a different account (two seeded
 * `extra_accounts`, and the keeper behind the daemon token), so the account
 * in the answer names the credential, and a 401 names none.
 *
 * Every row is sent twice:
 *
 * - as an RPC `POST` — status, the answering account, the session
 *   `Set-Cookie` lines (exactly the clearing string, or none), and exactly one
 *   response on the connection;
 * - as a WebSocket upgrade (`capabilities.ws`) — `101` when a credential
 *   authenticates and `401` otherwise, the clear on a refusal and never on an
 *   accepted upgrade; and on the accepted socket an `account_verify` frame
 *   (`capabilities.ws_account_actions`), whose answering account names the
 *   credential the upgrade was admitted on.
 *
 * A request carries no `Origin`, which the bearer and daemon-token legs would
 * read as a browser context.
 *
 * Beside the table, imperative cases for what a row can't say: the clear's
 * scope (cleared on an unrouted path under the auth scope and on its bare
 * prefix, not outside it), its order against a handler's own `Set-Cookie` (a
 * login carrying a stale cookie answers the clear, then the new cookie), and
 * the cookie a login mints being the raw signed value, which authenticates as
 * sent.
 *
 * **What it needs of a backend**, beyond the spine's auth stack:
 *
 * - `account_verify` on the RPC endpoint (`rpc_path`), admitting a session, an
 *   API token and the daemon token — the standard account actions. A backend
 *   answering `method_not_found` fails the suite naming it.
 * - The `POST` login route at `login_path`.
 * - A `setup_test` seeding the two `extra_accounts` named here, the session
 *   one with `CREDENTIAL_SESSION_ACCOUNT_PASSWORD` (the login case signs in as
 *   it — the suite creates no account of its own, so it needs neither signup
 *   nor invites), and no `extra_actors`: the upgrade leg sends no `acting`
 *   selector, which a multi-actor keeper's upgrade requires.
 * - With `capabilities.ws`: the upgrade at `ws_path` admitting each of the
 *   three credentials with no `Origin`. Where the upgrade is role-gated, the
 *   two accounts and the keeper hold its roles (seeded — `extra_accounts`'
 *   `roles` and `extra_keeper_roles`).
 * - With `capabilities.ws_account_actions`: `account_verify` on that socket.
 *   Without it the upgrade leg pins status and clear alone.
 *
 * Raw-socket by necessity, so **cross-process only**.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { parse } from '@fuzdev/fuz_schema/schema.ts';

import { SessionAccountJson } from '../../auth/account_schema.ts';
import {
	CREDENTIAL_TYPE_API_TOKEN,
	CREDENTIAL_TYPE_DAEMON_TOKEN,
	CREDENTIAL_TYPE_SESSION,
	type BuiltinCredentialType
} from '../../auth/credential_type_schema.ts';
import { HEALTH_PATH } from '../../http/health_schema.ts';
import { JSONRPC_ERROR_CODES } from '../../http/jsonrpc_errors.ts';
import type { TestAccount } from '../app_server.ts';
import {
	raw_http_count_responses,
	raw_http_exchange,
	raw_http_header_values,
	raw_http_parse_json,
	raw_http_parse_response,
	raw_http_request,
	RAW_HTTP_READ_TIMEOUT_MS,
	type RawHttpResponse
} from '../transports/raw_http.ts';
import {
	connect_raw_ws,
	is_raw_ws_close,
	RAW_WS_OPCODE_TEXT,
	type RawWsFrame
} from '../transports/ws_raw_client.ts';
import { test_if, type BackendCapabilities } from './capabilities.ts';
import {
	build_credential_conformance_placeholders,
	create_credential_conformance_keyring,
	load_credential_conformance,
	to_credential_conformance_checks,
	type CredentialConformanceCheck
} from './credential_conformance.ts';
import type { SetupTest, TestFixture } from './setup.ts';
import {
	SPINE_ACCOUNT_LOGIN_PATH,
	SPINE_RPC_PATH,
	SPINE_WS_PATH
} from './spine_surface_constants.ts';

/**
 * The `extra_accounts` username whose session cookie the rows send. The
 * suite's `setup_test` must seed it, with
 * `CREDENTIAL_SESSION_ACCOUNT_PASSWORD`.
 */
export const CREDENTIAL_SESSION_ACCOUNT_USERNAME = 'credential_session';

/**
 * The password the `CREDENTIAL_SESSION_ACCOUNT_USERNAME` account is seeded
 * with (`ExtraAccountSpec.password_value`) — the login case signs in as it.
 */
export const CREDENTIAL_SESSION_ACCOUNT_PASSWORD = 'credential-session-password';

/**
 * The `extra_accounts` username whose API token the rows send. The suite's
 * `setup_test` must seed it.
 */
export const CREDENTIAL_BEARER_ACCOUNT_USERNAME = 'credential_bearer';

/** Options for `describe_credential_conformance_wire_cross_tests`. */
export interface CredentialConformanceWireCrossTestOptions {
	/**
	 * Per-test fixture producer (cross-process), seeding the
	 * `CREDENTIAL_SESSION_ACCOUNT_USERNAME` (with
	 * `CREDENTIAL_SESSION_ACCOUNT_PASSWORD`) and
	 * `CREDENTIAL_BEARER_ACCOUNT_USERNAME` `extra_accounts`, and no
	 * `extra_actors`. Where the backend's WebSocket upgrade is role-gated, both
	 * accounts and the keeper (`extra_keeper_roles`) hold its roles.
	 */
	readonly setup_test: SetupTest;
	/**
	 * `ws` gates the upgrade leg, `ws_account_actions` its `account_verify`
	 * frame on each accepted socket.
	 */
	readonly capabilities: BackendCapabilities;
	/** Base URL the spawned backend is reachable at (e.g. `http://localhost:1178`). */
	readonly base_url: string;
	/** The spine's session cookie name (`handle.config.cookie_name`). */
	readonly cookie_name: string;
	/**
	 * The backend's `SECRET_FUZ_COOKIE_KEYS` value
	 * (`handle.config.env.SECRET_FUZ_COOKIE_KEYS`) — the suite signs the cookie
	 * spellings the table names with its primary key.
	 */
	readonly cookie_keys: string;
	/** A valid daemon token (keeper) — `handle.daemon_token`. */
	readonly daemon_token: string;
	/** JSON-RPC endpoint path. Default `SPINE_RPC_PATH`. */
	readonly rpc_path?: string;
	/** WebSocket endpoint path. Default `SPINE_WS_PATH`. */
	readonly ws_path?: string;
	/** REST login route path. Default `SPINE_ACCOUNT_LOGIN_PATH`. */
	readonly login_path?: string;
}

/**
 * The attributes both spines write on every session `Set-Cookie`, in their
 * order. An independent copy of each spine's `SESSION_COOKIE_ATTRIBUTES`, so a
 * change to either producer's string fails here — the TS spine's too, which
 * this module could otherwise only compare with itself.
 */
const WIRE_SESSION_COOKIE_ATTRIBUTES = 'Path=/; HttpOnly; Secure; SameSite=Strict';

/** An upgrade request's own header lines, with RFC 6455's sample key. */
const WS_UPGRADE_HEADER_LINES: ReadonlyArray<string> = [
	'Connection: Upgrade',
	'Upgrade: websocket',
	'Sec-WebSocket-Version: 13',
	'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='
];

/** The id of the `account_verify` call every row sends. */
const VERIFY_ID = 'credential';

/** The `account_verify` call every row sends — an RPC body, and a socket frame. */
const VERIFY_BODY = JSON.stringify({ jsonrpc: '2.0', id: VERIFY_ID, method: 'account_verify' });

/** How long an accepted socket has to answer its `account_verify` frame. */
const VERIFY_FRAME_TIMEOUT_MS = 5_000;

/** What an `account_verify` answer says of the credential behind it. */
type AuthenticatedCredential = BuiltinCredentialType | { readonly unexpected: string };

const describe_credential = (credential: AuthenticatedCredential | null): string =>
	typeof credential === 'object' && credential !== null
		? credential.unexpected
		: String(credential);

/** The accounts behind the three credentials of one fixture. */
interface CredentialAccounts {
	readonly session: TestAccount;
	readonly bearer: TestAccount;
	/** The keeper's account id — who the daemon token authenticates as. */
	readonly keeper_id: string;
}

const credential_accounts = (fixture: TestFixture): CredentialAccounts => {
	const session = fixture.extra_accounts[CREDENTIAL_SESSION_ACCOUNT_USERNAME];
	const bearer = fixture.extra_accounts[CREDENTIAL_BEARER_ACCOUNT_USERNAME];
	assert.ok(
		session && bearer,
		`the suite's setup_test must seed the extra_accounts '${CREDENTIAL_SESSION_ACCOUNT_USERNAME}' ` +
			`and '${CREDENTIAL_BEARER_ACCOUNT_USERNAME}'`
	);
	const ids = new Set([session.account.id, bearer.account.id, fixture.account.id]);
	assert.strictEqual(ids.size, 3, 'the three credentials belong to three accounts');
	return { session, bearer, keeper_id: fixture.account.id };
};

/** The session cookie's `Set-Cookie` lines of a response, in the order sent. */
const session_set_cookies = (received: string, cookie_name: string): Array<string> =>
	raw_http_header_values(received, 'set-cookie').filter((value) =>
		value.startsWith(`${cookie_name}=`)
	);

export const describe_credential_conformance_wire_cross_tests = (
	options: CredentialConformanceWireCrossTestOptions
): void => {
	const { setup_test, capabilities, base_url, cookie_name, daemon_token } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;
	const ws_path = options.ws_path ?? SPINE_WS_PATH;
	const login_path = options.login_path ?? SPINE_ACCOUNT_LOGIN_PATH;
	const host = new URL(base_url).host;
	const table = load_credential_conformance();
	const keyring = create_credential_conformance_keyring(options.cookie_keys);
	// the clearing `Set-Cookie`, byte for byte, spelled here rather than built
	// by the TS spine's formatter
	const clear_cookie = `${cookie_name}=; ${WIRE_SESSION_COOKIE_ATTRIBUTES}; Max-Age=0`;

	/** The table's wire rows, filled with this fixture's live credentials. */
	const wire_checks = async (
		accounts: CredentialAccounts
	): Promise<Array<CredentialConformanceCheck>> => {
		const placeholders = await build_credential_conformance_placeholders({
			cookie_name,
			session_cookie: accounts.session.session_cookie,
			api_token: accounts.bearer.api_token,
			daemon_token,
			keyring
		});
		return to_credential_conformance_checks(table, placeholders);
	};

	/** POST `account_verify` carrying `lines`, read until the server closes. */
	const send_verify = async (
		lines: ReadonlyArray<string>
	): Promise<{ received: string; response: RawHttpResponse | null }> => {
		const { received } = await raw_http_exchange(
			base_url,
			raw_http_request({
				method: 'POST',
				path: rpc_path,
				host,
				header_lines: ['Content-Type: application/json', ...lines, 'Connection: close'],
				body: VERIFY_BODY
			}),
			{ read_timeout_ms: RAW_HTTP_READ_TIMEOUT_MS }
		);
		return { received, response: raw_http_parse_response(received) };
	};

	/**
	 * The credential an `account_verify` envelope names, by the account it
	 * answers as.
	 *
	 * @throws Error when the backend has no `account_verify` there — a missing requirement, not a row's failure
	 */
	const credential_of_envelope = (
		envelope: unknown,
		accounts: CredentialAccounts,
		where: string
	): AuthenticatedCredential => {
		const { result, error } = (envelope ?? {}) as {
			result?: unknown;
			error?: { code?: unknown };
		};
		if (error?.code === JSONRPC_ERROR_CODES.method_not_found) {
			throw new Error(
				`describe_credential_conformance_wire_cross_tests: the backend answers method_not_found ` +
					`for account_verify on ${where} — the suite reads which credential authenticated from it`
			);
		}
		const account = parse(SessionAccountJson, result);
		if (!account.ok) return { unexpected: 'an answer whose result is no account' };
		switch (account.value.id) {
			case accounts.session.account.id:
				return CREDENTIAL_TYPE_SESSION;
			case accounts.bearer.account.id:
				return CREDENTIAL_TYPE_API_TOKEN;
			case accounts.keeper_id:
				return CREDENTIAL_TYPE_DAEMON_TOKEN;
			default:
				return { unexpected: 'an account behind none of the three credentials' };
		}
	};

	/** The credential an RPC `account_verify` response names; `null` for a 401. */
	const authenticated_credential = (
		response: RawHttpResponse,
		accounts: CredentialAccounts
	): AuthenticatedCredential | null => {
		if (response.status === 401) return null;
		const envelope = raw_http_parse_json(response.body);
		const credential = credential_of_envelope(envelope, accounts, `the RPC endpoint (${rpc_path})`);
		if (response.status !== 200) return { unexpected: `status ${response.status}` };
		return credential;
	};

	/**
	 * Send one row as a WebSocket upgrade a credential should not authenticate.
	 *
	 * @returns what disagrees with the row, empty when nothing does
	 */
	const check_refused_upgrade = async (
		check: CredentialConformanceCheck
	): Promise<Array<string>> => {
		const { received } = await raw_http_exchange(
			base_url,
			raw_http_request({
				method: 'GET',
				path: ws_path,
				host,
				header_lines: [...WS_UPGRADE_HEADER_LINES, ...check.lines]
			}),
			{ read_timeout_ms: RAW_HTTP_READ_TIMEOUT_MS, until: 'response' }
		);
		const response = raw_http_parse_response(received);
		if (!response) return [`no whole response (${received.slice(0, 80)})`];
		if (response.status !== 401) return [`expected 401, got ${response.status}`];
		const cleared = session_set_cookies(received, cookie_name);
		const expected_cleared = check.row.clears_session_cookie ? [clear_cookie] : [];
		if (JSON.stringify(cleared) !== JSON.stringify(expected_cleared)) {
			return [
				`expected session Set-Cookie lines ${JSON.stringify(expected_cleared)} ` +
					`on the 401, got ${cleared.length}`
			];
		}
		return [];
	};

	/**
	 * Send one row as a WebSocket upgrade a credential should authenticate, and
	 * ask the socket who it is.
	 *
	 * @returns what disagrees with the row, empty when nothing does
	 */
	const check_accepted_upgrade = async (
		check: CredentialConformanceCheck,
		accounts: CredentialAccounts
	): Promise<Array<string>> => {
		const url = new URL(base_url);
		let client;
		try {
			client = await connect_raw_ws({
				port: Number(url.port),
				hostname: url.hostname,
				path: ws_path,
				header_lines: check.lines
			});
		} catch (error) {
			return [`expected 101: ${error instanceof Error ? error.message : String(error)}`];
		}
		try {
			const failures: Array<string> = [];
			const cleared = session_set_cookies(client.handshake, cookie_name);
			if (cleared.length > 0) {
				failures.push(`expected no session Set-Cookie on the 101, got ${cleared.length}`);
			}
			if (!capabilities.ws_account_actions) return failures;
			client.send_text(VERIFY_BODY);
			const is_answer = (frame: RawWsFrame): boolean =>
				is_raw_ws_close(frame) ||
				(frame.opcode === RAW_WS_OPCODE_TEXT &&
					(raw_http_parse_json(frame.payload.toString('utf-8')) as { id?: unknown } | undefined)
						?.id === VERIFY_ID);
			let frame;
			try {
				frame = await client.wait_for(is_answer, VERIFY_FRAME_TIMEOUT_MS);
			} catch {
				return [...failures, 'the accepted socket never answered account_verify'];
			}
			if (is_raw_ws_close(frame)) {
				return [...failures, 'the accepted socket closed instead of answering account_verify'];
			}
			const credential = credential_of_envelope(
				raw_http_parse_json(frame.payload.toString('utf-8')),
				accounts,
				`the WebSocket endpoint (${ws_path}), which capabilities.ws_account_actions says mounts it`
			);
			if (credential !== check.row.authenticates) {
				failures.push(
					`expected the socket to be ${String(check.row.authenticates)}'s, ` +
						`got ${describe_credential(credential)}`
				);
			}
			return failures;
		} finally {
			client.destroy();
		}
	};

	describe('credential conformance on the wire', () => {
		test('every row authenticates as the credential it names, and clears the cookie when it says so', async () => {
			const fixture = await setup_test();
			const accounts = credential_accounts(fixture);
			const checks = await wire_checks(accounts);
			const failures: Array<string> = [];
			for (const check of checks) {
				const { received, response } = await send_verify(check.lines);
				if (!response) {
					failures.push(`${check.label}: no whole response (${received.slice(0, 80)})`);
					continue;
				}
				if (raw_http_count_responses(received) !== 1) {
					failures.push(`${check.label}: more than one response on the connection`);
				}
				const authenticated = authenticated_credential(response, accounts);
				if (authenticated !== check.row.authenticates) {
					failures.push(
						`${check.label}: expected ${String(check.row.authenticates)} to authenticate, ` +
							`got ${describe_credential(authenticated)}`
					);
				}
				const cleared = session_set_cookies(received, cookie_name);
				const expected_cleared = check.row.clears_session_cookie ? [clear_cookie] : [];
				if (JSON.stringify(cleared) !== JSON.stringify(expected_cleared)) {
					failures.push(
						`${check.label}: expected session Set-Cookie lines ${JSON.stringify(expected_cleared)}, ` +
							`got ${cleared.length} (${cleared.map((value) => value.replace(/=[^;]*/, '=…')).join(' | ')})`
					);
				}
			}
			assert.ok(checks.length > 0, 'the table has wire rows');
			assert.ok(
				failures.length === 0,
				`${failures.length} credential conformance rows disagree on the wire:\n${failures.join('\n')}`
			);
		});

		test_if(
			capabilities.ws,
			'every row upgrades a WebSocket exactly when a credential authenticates, as that credential, and a refusal clears the cookie',
			async () => {
				const fixture = await setup_test();
				assert.strictEqual(
					fixture.extra_actors.length,
					0,
					"the suite's setup_test must seed no extra_actors: the upgrades carry no acting selector"
				);
				const accounts = credential_accounts(fixture);
				const checks = await wire_checks(accounts);
				const failures: Array<string> = [];
				for (const check of checks) {
					const disagreements =
						check.row.authenticates === null
							? await check_refused_upgrade(check)
							: await check_accepted_upgrade(check, accounts);
					for (const disagreement of disagreements) {
						failures.push(`${check.label}: ${disagreement}`);
					}
				}
				assert.ok(checks.length > 0, 'the table has wire rows');
				assert.ok(
					failures.length === 0,
					`${failures.length} credential conformance rows disagree on a WebSocket upgrade:\n` +
						failures.join('\n')
				);
			}
		);

		test('an invalid cookie is cleared under the auth scope and nowhere else', async () => {
			const probes: ReadonlyArray<readonly [path: string, cleared: boolean]> = [
				// unrouted, under the scope
				['/api/credential-conformance-unrouted', true],
				// the scope's bare prefix, and the prefix with its slash
				['/api', true],
				['/api/', true],
				// a sibling that only starts with the prefix's letters
				['/apix', false],
				['/health-credential-conformance-unrouted', false],
				[HEALTH_PATH, false]
			];
			for (const [path, cleared] of probes) {
				const { received } = await raw_http_exchange(
					base_url,
					raw_http_request({
						method: 'GET',
						path,
						host,
						header_lines: [`Cookie: ${cookie_name}=bogus`, 'Connection: close']
					}),
					{ read_timeout_ms: RAW_HTTP_READ_TIMEOUT_MS }
				);
				assert.ok(raw_http_parse_response(received), `${path}: a whole response`);
				assert.deepStrictEqual(
					session_set_cookies(received, cookie_name),
					cleared ? [clear_cookie] : [],
					`GET ${path} carrying an invalid session cookie`
				);
			}
		});

		test('a login carrying a stale cookie answers the clear, then the new cookie — which authenticates as sent', async () => {
			const fixture = await setup_test();
			const accounts = credential_accounts(fixture);
			const { received } = await raw_http_exchange(
				base_url,
				raw_http_request({
					method: 'POST',
					path: login_path,
					host,
					header_lines: [
						'Content-Type: application/json',
						`Cookie: ${cookie_name}=bogus`,
						'Connection: close'
					],
					body: JSON.stringify({
						username: CREDENTIAL_SESSION_ACCOUNT_USERNAME,
						password: CREDENTIAL_SESSION_ACCOUNT_PASSWORD
					})
				}),
				{ read_timeout_ms: RAW_HTTP_READ_TIMEOUT_MS }
			);
			const response = raw_http_parse_response(received);
			assert.strictEqual(
				response?.status,
				200,
				`the login at ${login_path} succeeds as '${CREDENTIAL_SESSION_ACCOUNT_USERNAME}', seeded with ` +
					`CREDENTIAL_SESSION_ACCOUNT_PASSWORD: ${received.slice(0, 120)}`
			);
			const set_cookies = session_set_cookies(received, cookie_name);
			assert.strictEqual(set_cookies.length, 2, 'the clear and the new cookie, nothing else');
			assert.strictEqual(set_cookies[0], clear_cookie, 'the clear comes first');
			// the new cookie: the raw signed value, then the fixed attributes
			const prefix = `${cookie_name}=`;
			const minted = /^([^;]+); (.+); Max-Age=([1-9]\d*)$/.exec(
				set_cookies[1]!.slice(prefix.length)
			);
			assert.ok(minted, 'the new cookie is `name=value; <attributes>; Max-Age=<seconds>`');
			assert.strictEqual(minted[2], WIRE_SESSION_COOKIE_ATTRIBUTES);
			const value = minted[1]!;
			const verified = await keyring.verify(value);
			assert.ok(verified, 'the minted value verifies as written — nothing to decode');
			// and the value, sent back byte for byte, authenticates as the account
			const { response: verify } = await send_verify([`Cookie: ${cookie_name}=${value}`]);
			assert.ok(verify, 'a whole response to the minted cookie');
			assert.strictEqual(verify.status, 200, 'the minted cookie authenticates');
			assert.strictEqual(
				authenticated_credential(verify, accounts),
				CREDENTIAL_TYPE_SESSION,
				'and it is the account that logged in'
			);
		});
	});
};
