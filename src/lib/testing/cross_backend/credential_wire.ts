import '../assert_dev_env.ts';

/**
 * What the raw-socket conformance suites share: the accounts that name a
 * credential, the raw `account_verify` request and upgrade they send, and how
 * they read which credential an answer is for.
 *
 * Each of the three credentials belongs to a different account — the session
 * cookie and the API token to two seeded `extra_accounts`, the daemon token to
 * the keeper — so the account `account_verify` answers as names the
 * credential that authenticated, and a 401 names none.
 * `credential_conformance_wire.ts` and `request_header_conformance_wire.ts`
 * read their rows' outcomes this way.
 *
 * @module
 */

import { assert } from 'vitest';
import { parse } from '@fuzdev/fuz_schema/schema.ts';

import { SessionAccountJson } from '../../auth/account_schema.ts';
import {
	CREDENTIAL_TYPE_API_TOKEN,
	CREDENTIAL_TYPE_DAEMON_TOKEN,
	CREDENTIAL_TYPE_SESSION,
	type BuiltinCredentialType
} from '../../auth/credential_type_schema.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from '../../auth/role_schema.ts';
import { JSONRPC_ERROR_CODES } from '../../http/jsonrpc_errors.ts';
import type { TestAccount } from '../test_app.ts';
import {
	raw_http_exchange,
	raw_http_parse_json,
	raw_http_parse_response,
	raw_http_request,
	RAW_HTTP_READ_TIMEOUT_MS,
	type RawHttpResponse
} from '../transports/raw_http.ts';
import {
	is_raw_ws_close,
	RAW_WS_OPCODE_TEXT,
	type RawWsClient
} from '../transports/ws_raw_client.ts';
import type { CrossProcessSetupOptions, TestFixture } from './setup.ts';

/**
 * The `extra_accounts` username whose session cookie the suites send. Their
 * `setup_test` must seed it, with `CREDENTIAL_SESSION_ACCOUNT_PASSWORD`.
 */
export const CREDENTIAL_SESSION_ACCOUNT_USERNAME = 'credential_session';

/**
 * The password the `CREDENTIAL_SESSION_ACCOUNT_USERNAME` account is seeded
 * with (`ExtraAccountSpec.password_value`) — the credential suite's login
 * case signs in as it.
 */
export const CREDENTIAL_SESSION_ACCOUNT_PASSWORD = 'credential-session-password';

/**
 * The `extra_accounts` username whose API token the suites send. Their
 * `setup_test` must seed it.
 */
export const CREDENTIAL_BEARER_ACCOUNT_USERNAME = 'credential_bearer';

/**
 * The seeding the credential suites need: the two accounts, each holding
 * `ws_required_roles` so it can open a socket where the upgrade is
 * role-gated, and the keeper behind the daemon token holding them too.
 *
 * @param ws_required_roles - the roles the backend's WebSocket upgrade requires
 */
export const create_credential_wire_seed = (
	ws_required_roles: ReadonlyArray<string> = []
): CrossProcessSetupOptions => ({
	// the keeper already holds the builtin roles
	extra_keeper_roles: ws_required_roles.filter(
		(role) => role !== ROLE_KEEPER && role !== ROLE_ADMIN
	),
	extra_accounts: [
		{
			username: CREDENTIAL_SESSION_ACCOUNT_USERNAME,
			password_value: CREDENTIAL_SESSION_ACCOUNT_PASSWORD,
			roles: [...ws_required_roles]
		},
		{ username: CREDENTIAL_BEARER_ACCOUNT_USERNAME, roles: [...ws_required_roles] }
	]
});

/** What an `account_verify` answer says of the credential behind it. */
export type AuthenticatedCredential = BuiltinCredentialType | { readonly unexpected: string };

/** A credential reading for a failure message. */
export const format_authenticated_credential = (
	credential: AuthenticatedCredential | null
): string =>
	typeof credential === 'object' && credential !== null
		? credential.unexpected
		: String(credential);

/** The accounts behind the three credentials of one fixture. */
export interface CredentialWireAccounts {
	readonly session: TestAccount;
	readonly bearer: TestAccount;
	/** The keeper's account id — who the daemon token authenticates as. */
	readonly keeper_id: string;
}

/**
 * The fixture's three credential accounts.
 *
 * @throws AssertionError when the fixture lacks the seeded accounts, or two credentials share one
 */
export const read_credential_wire_accounts = (fixture: TestFixture): CredentialWireAccounts => {
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

/** The id of the `account_verify` call the suites send. */
export const CREDENTIAL_WIRE_VERIFY_ID = 'credential';

/** The `account_verify` call the suites send — an RPC body, and a socket frame. */
export const CREDENTIAL_WIRE_VERIFY_BODY = JSON.stringify({
	jsonrpc: '2.0',
	id: CREDENTIAL_WIRE_VERIFY_ID,
	method: 'account_verify'
});

/** An upgrade request's own header lines, with RFC 6455's sample key. */
export const WS_UPGRADE_HEADER_LINES: ReadonlyArray<string> = [
	'Connection: Upgrade',
	'Upgrade: websocket',
	'Sec-WebSocket-Version: 13',
	'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='
];

/** How long an accepted socket has to answer its `account_verify` frame. */
const VERIFY_FRAME_TIMEOUT_MS = 5_000;

/**
 * The credential an `account_verify` envelope names, by the account it
 * answers as.
 *
 * @param suite - the calling suite, named in the throw
 * @throws Error when the backend has no `account_verify` there — a missing requirement, not a row's failure
 */
export const credential_of_verify_envelope = (
	envelope: unknown,
	accounts: CredentialWireAccounts,
	where: string,
	suite: string
): AuthenticatedCredential => {
	const { result, error } = (envelope ?? {}) as {
		result?: unknown;
		error?: { code?: unknown };
	};
	if (error?.code === JSONRPC_ERROR_CODES.method_not_found) {
		throw new Error(
			`${suite}: the backend answers method_not_found for account_verify on ${where} — ` +
				'the suite reads which credential authenticated from it'
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

/** One raw request a suite sends. */
export interface CredentialWireRequest {
	/** Base URL the backend is reachable at; only its host and port are used. */
	readonly base_url: string;
	/** The `Host` to write, or `null` when `header_lines` carry the request's `Host` lines. */
	readonly host: string | null;
	/** The header lines, written in order and as given. */
	readonly header_lines: ReadonlyArray<string>;
}

/**
 * `POST` `account_verify` to `rpc_path` carrying `header_lines` (and
 * `Connection: close`), read until the server closes.
 */
export const send_raw_verify = async (
	request: CredentialWireRequest & { readonly rpc_path: string }
): Promise<{ received: string; response: RawHttpResponse | null }> => {
	const { received } = await raw_http_exchange(
		request.base_url,
		raw_http_request({
			method: 'POST',
			path: request.rpc_path,
			host: request.host,
			header_lines: [...request.header_lines, 'Connection: close'],
			body: CREDENTIAL_WIRE_VERIFY_BODY
		}),
		{ read_timeout_ms: RAW_HTTP_READ_TIMEOUT_MS }
	);
	return { received, response: raw_http_parse_response(received) };
};

/**
 * The credential an RPC `account_verify` response names; `null` for a 401.
 *
 * @param suite - the calling suite, named in a throw
 */
export const credential_of_verify_response = (
	response: RawHttpResponse,
	accounts: CredentialWireAccounts,
	rpc_path: string,
	suite: string
): AuthenticatedCredential | null => {
	if (response.status === 401) return null;
	const envelope = raw_http_parse_json(response.body);
	const credential = credential_of_verify_envelope(
		envelope,
		accounts,
		`the RPC endpoint (${rpc_path})`,
		suite
	);
	if (response.status !== 200) return { unexpected: `status ${response.status}` };
	return credential;
};

/**
 * Send a WebSocket upgrade to `ws_path` carrying `header_lines` after the
 * upgrade's own lines, and read the first response — for an upgrade the
 * caller expects refused.
 */
export const send_raw_upgrade = async (
	request: CredentialWireRequest & { readonly ws_path: string }
): Promise<{ received: string; response: RawHttpResponse | null }> => {
	const { received } = await raw_http_exchange(
		request.base_url,
		raw_http_request({
			method: 'GET',
			path: request.ws_path,
			host: request.host,
			header_lines: [...WS_UPGRADE_HEADER_LINES, ...request.header_lines]
		}),
		{ read_timeout_ms: RAW_HTTP_READ_TIMEOUT_MS, until: 'response' }
	);
	return { received, response: raw_http_parse_response(received) };
};

/**
 * Ask an accepted socket who it is: send `account_verify` and read the
 * credential its answer names.
 *
 * @param suite - the calling suite, named in a throw
 * @returns the credential, or why none could be read
 */
export const verify_socket_credential = async (
	client: RawWsClient,
	accounts: CredentialWireAccounts,
	ws_path: string,
	suite: string
): Promise<{ credential: AuthenticatedCredential } | { failure: string }> => {
	client.send_text(CREDENTIAL_WIRE_VERIFY_BODY);
	let frame;
	try {
		frame = await client.wait_for(
			(candidate) =>
				is_raw_ws_close(candidate) ||
				(candidate.opcode === RAW_WS_OPCODE_TEXT &&
					(raw_http_parse_json(candidate.payload.toString('utf-8')) as { id?: unknown } | undefined)
						?.id === CREDENTIAL_WIRE_VERIFY_ID),
			VERIFY_FRAME_TIMEOUT_MS
		);
	} catch {
		return { failure: 'the accepted socket never answered account_verify' };
	}
	if (is_raw_ws_close(frame)) {
		return { failure: 'the accepted socket closed instead of answering account_verify' };
	}
	return {
		credential: credential_of_verify_envelope(
			raw_http_parse_json(frame.payload.toString('utf-8')),
			accounts,
			`the WebSocket endpoint (${ws_path}), which capabilities.ws_account_actions says mounts it`,
			suite
		)
	};
};
