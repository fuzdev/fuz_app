import '../assert_dev_env.ts';

/**
 * The request header conformance table over raw sockets: each wire row's
 * header lines sent to the live backend as they are written, and the real
 * outcome asserted — which gate refused the request, with which code, or which
 * credential authenticated it.
 *
 * Where the unit legs read the lines with each spine's readers, this sends
 * them: the runtime's HTTP parser, its view of repeated and empty lines (on
 * `@hono/node-server` a WebSocket upgrade's `Headers` are rebuilt from Node's
 * deduplicated view), and the whole middleware chain sit between the bytes
 * and the answer. It is what proves the gates read the lines the client sent
 * on every runtime and on every path, the upgrade included. It needs no
 * backdoor.
 *
 * Every wire row is sent:
 *
 * - as an RPC `POST` of `account_verify` — `post`: the refusal's status and
 *   code, or the credential the answering account names (`null` for a 401);
 * - when the row carries a `Content-Type` line, also as a `POST` to the login
 *   route with a wrong password — the second site that checks a JSON body's
 *   content type: the same refusal, or the route's own 401;
 * - as a WebSocket upgrade (`capabilities.ws`) — `upgrade`: the refusal's
 *   status (and its code where the runtime sends a refusal's body,
 *   `capabilities.ws_refusal_body`), a 401 for no credential, or a `101` whose
 *   socket answers `account_verify` as the credential named
 *   (`capabilities.ws_account_actions`; without it the `101` alone). A row
 *   naming an `upgrade_runtime_refusal` the backend declares
 *   (`capabilities.ws_upgrade_runtime_refusals`) instead expects that
 *   runtime's answer: a 400 before the app runs, never a `101`.
 *
 * The leg adds a `Host` naming the server to a row with no `Host` line, and
 * `Content-Type: application/json` to the `POST`s of a row with no
 * `Content-Type` line. The accounts are `credential_wire.ts`'s.
 *
 * **What it needs of a backend**: what `credential_conformance_wire.ts`
 * needs — `account_verify` on `rpc_path` and on the socket, the login route,
 * the seeded accounts, no `extra_actors` — and an allowlist admitting
 * `origin` (default the origin of `base_url`) and refusing
 * `REQUEST_HEADER_WIRE_FOREIGN_ORIGIN`. The rows the table expects the host
 * gate to refuse run where `capabilities.host_gate` says the gate is on, and
 * the gate must refuse `REQUEST_HEADER_WIRE_FOREIGN_HOST`; a backend with the
 * gate off declares `false`, and those rows show as skipped tests.
 *
 * Raw-socket by necessity, so **cross-process only**.
 *
 * @module
 */

import { assert, describe } from 'vitest';

import {
	ERROR_FORBIDDEN_HOST,
	ERROR_FORBIDDEN_ORIGIN,
	ERROR_UNSUPPORTED_CONTENT_TYPE
} from '../../http/error_schemas.ts';
import {
	raw_http_error_code,
	raw_http_exchange,
	raw_http_parse_response,
	raw_http_request,
	RAW_HTTP_READ_TIMEOUT_MS,
	type RawHttpResponse
} from '../transports/raw_http.ts';
import { connect_raw_ws } from '../transports/ws_raw_client.ts';
import { test_if, type BackendCapabilities } from './capabilities.ts';
import {
	CREDENTIAL_SESSION_ACCOUNT_USERNAME,
	credential_of_verify_response,
	format_authenticated_credential,
	read_credential_wire_accounts,
	send_raw_upgrade,
	send_raw_verify,
	verify_socket_credential,
	type CredentialWireAccounts
} from './credential_wire.ts';
import {
	fill_request_header_conformance_placeholders,
	load_request_header_conformance,
	request_header_values,
	type RequestHeaderConformanceOutcome,
	type RequestHeaderConformancePlaceholders,
	type RequestHeaderConformanceRow
} from './request_header_conformance.ts';
import type { SetupTest } from './setup.ts';
import {
	SPINE_ACCOUNT_LOGIN_PATH,
	SPINE_RPC_PATH,
	SPINE_WS_PATH
} from './spine_surface_constants.ts';

/** The `{foreign_host}` the wire leg sends — a name no backend answers to. */
export const REQUEST_HEADER_WIRE_FOREIGN_HOST = 'rebind.example';

/** The `{foreign_origin}` the wire leg sends — an origin no backend allows. */
export const REQUEST_HEADER_WIRE_FOREIGN_ORIGIN = 'https://evil.example';

/** Options for `describe_request_header_conformance_wire_cross_tests`. */
export interface RequestHeaderConformanceWireCrossTestOptions {
	/**
	 * Per-test fixture producer (cross-process), seeding the accounts of
	 * `create_credential_wire_seed` and no `extra_actors`.
	 */
	readonly setup_test: SetupTest;
	/**
	 * `ws` gates the upgrade leg, `ws_account_actions` its `account_verify`
	 * frame on each accepted socket, `ws_refusal_body` whether a refused
	 * upgrade's code is read, `ws_upgrade_runtime_refusals` the rows that
	 * expect the runtime's own refusal, and `host_gate` the rows the host gate
	 * refuses.
	 */
	readonly capabilities: BackendCapabilities;
	/** Base URL the spawned backend is reachable at (e.g. `http://localhost:1178`). */
	readonly base_url: string;
	/** The spine's session cookie name (`handle.config.cookie_name`). */
	readonly cookie_name: string;
	/** A valid daemon token (keeper) — `handle.daemon_token`. */
	readonly daemon_token: string;
	/** An origin the backend's allowlist admits. Default the origin of `base_url`. */
	readonly origin?: string;
	/** JSON-RPC endpoint path. Default `SPINE_RPC_PATH`. */
	readonly rpc_path?: string;
	/** WebSocket endpoint path. Default `SPINE_WS_PATH`. */
	readonly ws_path?: string;
	/** REST login route path. Default `SPINE_ACCOUNT_LOGIN_PATH`. */
	readonly login_path?: string;
}

/** The suite's name, in a throw naming a missing requirement. */
const SUITE = 'describe_request_header_conformance_wire_cross_tests';

/** The status each refusal code answers with. */
const REFUSAL_STATUS: Readonly<Record<string, number>> = {
	[ERROR_FORBIDDEN_HOST]: 403,
	[ERROR_FORBIDDEN_ORIGIN]: 403,
	[ERROR_UNSUPPORTED_CONTENT_TYPE]: 415
};

/** The status `@hono/node-server` answers an upgrade it can't build a URL for, before the app runs. */
const RUNTIME_REFUSAL_STATUS = 400;

/** One wire row with its placeholders filled. */
interface WireCheck {
	readonly row: RequestHeaderConformanceRow;
	readonly post: RequestHeaderConformanceOutcome;
	readonly upgrade: RequestHeaderConformanceOutcome;
	/** The row's lines, filled. */
	readonly lines: Array<string>;
	/** Whether the lines carry a `Host` line — then the leg writes none of its own. */
	readonly has_host: boolean;
	/** Whether the lines carry a `Content-Type` line — then the leg adds none. */
	readonly has_content_type: boolean;
}

const format_outcome = (outcome: RequestHeaderConformanceOutcome): string =>
	'refused' in outcome ? `refused ${outcome.refused}` : String(outcome.authenticates);

/** Whether the table expects the host gate to refuse `outcome`. */
const is_host_gate_refusal = (outcome: RequestHeaderConformanceOutcome): boolean =>
	'refused' in outcome && outcome.refused === ERROR_FORBIDDEN_HOST;

export const describe_request_header_conformance_wire_cross_tests = (
	options: RequestHeaderConformanceWireCrossTestOptions
): void => {
	const { setup_test, capabilities, base_url, cookie_name, daemon_token } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;
	const ws_path = options.ws_path ?? SPINE_WS_PATH;
	const login_path = options.login_path ?? SPINE_ACCOUNT_LOGIN_PATH;
	const url = new URL(base_url);
	const host = url.host;
	const origin = options.origin ?? url.origin;
	const table = load_request_header_conformance();

	/** The table's wire rows, filled with this fixture's live credentials. */
	const wire_checks = (accounts: CredentialWireAccounts): Array<WireCheck> => {
		const placeholders: RequestHeaderConformancePlaceholders = {
			cookie_name,
			session_cookie: accounts.session.session_cookie,
			api_token: accounts.bearer.api_token,
			daemon_token,
			host,
			foreign_host: REQUEST_HEADER_WIRE_FOREIGN_HOST,
			origin,
			foreign_origin: REQUEST_HEADER_WIRE_FOREIGN_ORIGIN
		};
		const checks: Array<WireCheck> = [];
		for (const row of table.rows) {
			if (row.post === undefined || row.upgrade === undefined) continue;
			const lines = row.lines.map((line) =>
				fill_request_header_conformance_placeholders(line, placeholders)
			);
			checks.push({
				row,
				post: row.post,
				upgrade: row.upgrade,
				lines,
				has_host: request_header_values(lines, 'host').length > 0,
				has_content_type: request_header_values(lines, 'content-type').length > 0
			});
		}
		return checks;
	};

	/** The lines a `POST` of `check` carries: the default content type when the row has none. */
	const post_lines = (check: WireCheck): Array<string> =>
		check.has_content_type ? check.lines : ['Content-Type: application/json', ...check.lines];

	/**
	 * A refusal response against its expected code: the status, and the code
	 * when the body is there to read it.
	 *
	 * @param body_optional - the runtime may drop the body (a Node upgrade refusal)
	 */
	const check_refusal = (
		response: RawHttpResponse,
		code: string,
		body_optional: boolean
	): Array<string> => {
		const status = REFUSAL_STATUS[code]!;
		if (response.status !== status) {
			return [`expected ${status} ${code}, got ${response.status} (${response.body.slice(0, 80)})`];
		}
		if (body_optional && response.body === '') return [];
		const got = raw_http_error_code(response);
		return got === code ? [] : [`expected the code ${code}, got ${String(got)}`];
	};

	/** Send one row as an RPC `POST`. */
	const check_post = async (
		check: WireCheck,
		accounts: CredentialWireAccounts
	): Promise<Array<string>> => {
		const { received, response } = await send_raw_verify({
			base_url,
			rpc_path,
			host: check.has_host ? null : host,
			header_lines: post_lines(check)
		});
		if (!response) return [`no whole response (${received.slice(0, 80)})`];
		if ('refused' in check.post) return check_refusal(response, check.post.refused, false);
		const credential = credential_of_verify_response(response, accounts, rpc_path, SUITE);
		return credential === check.post.authenticates
			? []
			: [
					`expected ${String(check.post.authenticates)} to authenticate, ` +
						`got ${format_authenticated_credential(credential)}`
				];
	};

	/** Send one row as a login with a wrong password: the post's refusal, else the route's 401. */
	const check_login = async (check: WireCheck): Promise<Array<string>> => {
		const { received } = await raw_http_exchange(
			base_url,
			raw_http_request({
				method: 'POST',
				path: login_path,
				host: check.has_host ? null : host,
				header_lines: [...post_lines(check), 'Connection: close'],
				body: JSON.stringify({
					username: CREDENTIAL_SESSION_ACCOUNT_USERNAME,
					password: 'request-header-conformance-wrong-password'
				})
			}),
			{ read_timeout_ms: RAW_HTTP_READ_TIMEOUT_MS }
		);
		const response = raw_http_parse_response(received);
		if (!response) return [`login: no whole response (${received.slice(0, 80)})`];
		if ('refused' in check.post) {
			return check_refusal(response, check.post.refused, false).map((f) => `login: ${f}`);
		}
		return response.status === 401
			? []
			: [`login: expected the route's own 401, got ${response.status}`];
	};

	/** Send one row as a WebSocket upgrade. */
	const check_upgrade = async (
		check: WireCheck,
		accounts: CredentialWireAccounts
	): Promise<Array<string>> => {
		const runtime = check.row.upgrade_runtime_refusal;
		const expected = check.upgrade;
		const host_line = check.has_host ? null : host;
		if (
			(runtime !== undefined && capabilities.ws_upgrade_runtime_refusals.includes(runtime)) ||
			'refused' in expected ||
			expected.authenticates === null
		) {
			const { received, response } = await send_raw_upgrade({
				base_url,
				ws_path,
				host: host_line,
				header_lines: check.lines
			});
			if (!response) return [`no whole response (${received.slice(0, 80)})`];
			if (runtime !== undefined && capabilities.ws_upgrade_runtime_refusals.includes(runtime)) {
				return response.status === RUNTIME_REFUSAL_STATUS && response.body === ''
					? []
					: [
							`expected the runtime's bodiless ${RUNTIME_REFUSAL_STATUS} (${runtime}, declared by ` +
								`ws_upgrade_runtime_refusals), got ${response.status} (${response.body.slice(0, 80)})`
						];
			}
			if ('refused' in expected) {
				return check_refusal(response, expected.refused, !capabilities.ws_refusal_body);
			}
			return response.status === 401 ? [] : [`expected 401, got ${response.status}`];
		}
		let client;
		try {
			client = await connect_raw_ws({
				port: Number(url.port),
				hostname: url.hostname,
				host: host_line,
				path: ws_path,
				header_lines: check.lines
			});
		} catch (error) {
			return [`expected 101: ${error instanceof Error ? error.message : String(error)}`];
		}
		try {
			if (!capabilities.ws_account_actions) return [];
			const verified = await verify_socket_credential(client, accounts, ws_path, SUITE);
			if ('failure' in verified) return [verified.failure];
			return verified.credential === expected.authenticates
				? []
				: [
						`expected the socket to be ${expected.authenticates}'s, ` +
							`got ${format_authenticated_credential(verified.credential)}`
					];
		} finally {
			client.destroy();
		}
	};

	/** Send every row of `checks` as an RPC `POST` (and a login, when it carries a `Content-Type`). */
	const run_post_rows = async (
		checks: Array<WireCheck>,
		accounts: CredentialWireAccounts
	): Promise<Array<string>> => {
		const failures: Array<string> = [];
		for (const check of checks) {
			const label = `${check.row.name} [post, expected ${format_outcome(check.post)}]`;
			for (const failure of await check_post(check, accounts)) {
				failures.push(`${label}: ${failure}`);
			}
			if (!check.has_content_type) continue;
			for (const failure of await check_login(check)) {
				failures.push(`${label}: ${failure}`);
			}
		}
		return failures;
	};

	/** Send every row of `checks` as a WebSocket upgrade. */
	const run_upgrade_rows = async (
		checks: Array<WireCheck>,
		accounts: CredentialWireAccounts
	): Promise<Array<string>> => {
		const failures: Array<string> = [];
		for (const check of checks) {
			const label = `${check.row.name} [upgrade, expected ${format_outcome(check.upgrade)}]`;
			for (const failure of await check_upgrade(check, accounts)) {
				failures.push(`${label}: ${failure}`);
			}
		}
		return failures;
	};

	describe('request header conformance on the wire', () => {
		// Each leg runs in two tests: the rows the host gate refuses, gated on
		// `capabilities.host_gate`, and the rest.
		for (const host_gate_rows of [false, true]) {
			const which = host_gate_rows
				? 'every row the host gate refuses'
				: 'every row the host gate passes';
			test_if(
				!host_gate_rows || capabilities.host_gate,
				`${which} answers an RPC POST and a login as the table says`,
				async () => {
					const fixture = await setup_test();
					const accounts = read_credential_wire_accounts(fixture);
					const checks = wire_checks(accounts).filter(
						(check) => is_host_gate_refusal(check.post) === host_gate_rows
					);
					const failures = await run_post_rows(checks, accounts);
					assert.ok(checks.length > 0, 'the table has wire rows');
					assert.ok(
						failures.length === 0,
						`${failures.length} request header conformance rows disagree on a POST:\n${failures.join('\n')}`
					);
				}
			);

			test_if(
				capabilities.ws && (!host_gate_rows || capabilities.host_gate),
				`${which} answers a WebSocket upgrade as the table says`,
				async () => {
					const fixture = await setup_test();
					assert.strictEqual(
						fixture.extra_actors.length,
						0,
						"the suite's setup_test must seed no extra_actors: the upgrades carry no acting selector"
					);
					const accounts = read_credential_wire_accounts(fixture);
					const checks = wire_checks(accounts).filter(
						(check) => is_host_gate_refusal(check.upgrade) === host_gate_rows
					);
					const failures = await run_upgrade_rows(checks, accounts);
					assert.ok(checks.length > 0, 'the table has wire rows');
					assert.ok(
						failures.length === 0,
						`${failures.length} request header conformance rows disagree on a WebSocket upgrade:\n` +
							failures.join('\n')
					);
				}
			);
		}
	});
};
