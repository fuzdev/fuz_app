import '../assert_dev_env.ts';

/**
 * The request target conformance table over raw sockets: each `wire` row of
 * `request_target_conformance.json` sent to the live backend with its target
 * written byte for byte, and the answer's status, error code and — on a
 * JSON-RPC answer — envelope `id`, error code and `data.reason` asserted.
 *
 * Where the unit legs run each spine's strict readers over a query string or
 * a path segment, this sends the target: the runtime's request-line parser,
 * its URL, the router and the route's own phases sit between the bytes and
 * the answer, so it is what proves every surface that reads the query or the
 * path params reads them through the strict readers, in the phase order the
 * row pins. A fetch client can't send these targets — it would re-encode
 * them — so the leg is raw-socket, and **cross-process only**. It needs no
 * backdoor.
 *
 * A row is sent by its principal (`keeper_session`: the fixture's keeper
 * cookie; `none`: no credential), with no `Origin`, and only to a backend
 * declaring what `requires` names. An `upgrade` row is a WebSocket upgrade
 * (`capabilities.ws`): a `101` is the handshake accepted, and a refusal's
 * code is read where the runtime sends its body
 * (`capabilities.ws_refusal_body`).
 *
 * **What it needs of a backend**: the spine's RPC endpoint with
 * `account_verify` on `rpc_path`, the account status route, the WebSocket
 * endpoint on `ws_path`, and the fact routes at `/api/facts/:hash` and
 * `/api/cells/:cell_id/facts/:hash`, each as its capability declares, and a
 * single-actor keeper (no `extra_actors`) that holds the WebSocket upgrade's
 * roles.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import {
	raw_http_error_code,
	raw_http_exchange,
	raw_http_parse_json,
	raw_http_parse_response,
	raw_http_request,
	RAW_HTTP_READ_TIMEOUT_MS,
	type RawHttpResponse
} from '../transports/raw_http.ts';
import { connect_raw_ws } from '../transports/ws_raw_client.ts';
import { test_if, type BackendCapabilities } from './capabilities.ts';
import { send_raw_upgrade } from './credential_wire.ts';
import {
	fill_request_target_conformance_placeholders,
	load_request_target_conformance,
	type RequestTargetConformanceExpect,
	type RequestTargetConformanceWireRow
} from './request_target_conformance.ts';
import type { SetupTest, TestFixture } from './setup.ts';
import {
	SPINE_ACCOUNT_STATUS_PATH,
	SPINE_RPC_PATH,
	SPINE_WS_PATH
} from './spine_surface_constants.ts';

/** Options for `describe_request_target_conformance_wire_cross_tests`. */
export interface RequestTargetConformanceWireCrossTestOptions {
	/** Per-test fixture producer (cross-process), seeding no `extra_actors`. */
	readonly setup_test: SetupTest;
	/**
	 * `ws`, `account_status`, `fact_serving` and `fact_serving_admin_hash`
	 * gate the rows that require them; `ws_refusal_body` whether a refused
	 * upgrade's code is read.
	 */
	readonly capabilities: BackendCapabilities;
	/** Base URL the spawned backend is reachable at (e.g. `http://localhost:1178`). */
	readonly base_url: string;
	/** JSON-RPC endpoint path. Default `SPINE_RPC_PATH`. */
	readonly rpc_path?: string;
	/** WebSocket endpoint path. Default `SPINE_WS_PATH`. */
	readonly ws_path?: string;
	/** Account status route path. Default `SPINE_ACCOUNT_STATUS_PATH`. */
	readonly account_status_path?: string;
}

/** The parts of a JSON-RPC envelope a row pins. */
interface EnvelopeRead {
	readonly id: unknown;
	readonly code: unknown;
	readonly reason: unknown;
}

/** A raw response's body read as the UTF-8 it is — the raw transport reads one character a byte. */
const utf8_body = (response: RawHttpResponse): string =>
	Buffer.from(response.body, 'latin1').toString('utf8');

const read_envelope = (response: RawHttpResponse): EnvelopeRead | null => {
	const body = raw_http_parse_json(utf8_body(response)) as
		| { jsonrpc?: unknown; id?: unknown; error?: { code?: unknown; data?: { reason?: unknown } } }
		| undefined;
	if (body?.jsonrpc !== '2.0') return null;
	return { id: body.id, code: body.error?.code, reason: body.error?.data?.reason };
};

const format_expect = (expect: RequestTargetConformanceExpect): string =>
	[
		String(expect.status),
		expect.error,
		expect.jsonrpc && `id ${JSON.stringify(expect.jsonrpc.id)}`,
		expect.jsonrpc?.code,
		expect.jsonrpc?.reason
	]
		.filter((part) => part !== undefined)
		.join(' ');

/**
 * Hold one answer to its row's `expect`.
 *
 * @param body_optional - the runtime may drop a refusal's body (a Node upgrade refusal)
 */
const check_answer = (
	response: RawHttpResponse,
	expect: RequestTargetConformanceExpect,
	body_optional: boolean
): Array<string> => {
	const got = `got ${response.status} (${utf8_body(response).slice(0, 120)})`;
	if (response.status !== expect.status) return [`expected status ${expect.status}, ${got}`];
	if (body_optional && response.body === '') return [];
	const failures: Array<string> = [];
	if (expect.error !== undefined) {
		const code = raw_http_error_code(response);
		if (code !== expect.error) failures.push(`expected the code ${expect.error}, ${got}`);
	}
	if (expect.jsonrpc !== undefined) {
		const envelope = read_envelope(response);
		if (!envelope) return [...failures, `expected a JSON-RPC envelope, ${got}`];
		if (envelope.id !== expect.jsonrpc.id) {
			failures.push(`expected the id ${JSON.stringify(expect.jsonrpc.id)}, ${got}`);
		}
		if (expect.jsonrpc.code !== undefined && envelope.code !== expect.jsonrpc.code) {
			failures.push(`expected the error code ${expect.jsonrpc.code}, ${got}`);
		}
		if (expect.jsonrpc.reason !== undefined && envelope.reason !== expect.jsonrpc.reason) {
			failures.push(`expected the reason ${JSON.stringify(expect.jsonrpc.reason)}, ${got}`);
		}
	}
	return failures;
};

export const describe_request_target_conformance_wire_cross_tests = (
	options: RequestTargetConformanceWireCrossTestOptions
): void => {
	const { setup_test, capabilities, base_url } = options;
	const url = new URL(base_url);
	const placeholders = {
		rpc_path: options.rpc_path ?? SPINE_RPC_PATH,
		ws_path: options.ws_path ?? SPINE_WS_PATH,
		account_status_path: options.account_status_path ?? SPINE_ACCOUNT_STATUS_PATH
	};
	const table = load_request_target_conformance();

	/** Whether the backend declares what a row requires. */
	const backend_serves = (row: RequestTargetConformanceWireRow): boolean =>
		row.requires === undefined || capabilities[row.requires];

	/** The header lines a row's principal sends. */
	const principal_lines = (
		row: RequestTargetConformanceWireRow,
		fixture: TestFixture
	): Array<string> =>
		row.as === 'none'
			? []
			: Object.entries(fixture.create_session_headers()).map(
					([name, value]) => `${name}: ${value}`
				);

	const check_request = async (
		row: RequestTargetConformanceWireRow,
		fixture: TestFixture
	): Promise<Array<string>> => {
		const { received } = await raw_http_exchange(
			base_url,
			raw_http_request({
				method: row.method,
				path: fill_request_target_conformance_placeholders(row.target, placeholders),
				host: url.host,
				header_lines: [...principal_lines(row, fixture), 'Connection: close']
			}),
			{ read_timeout_ms: RAW_HTTP_READ_TIMEOUT_MS }
		);
		const response = raw_http_parse_response(received);
		if (!response) return [`no whole response (${received.slice(0, 80)})`];
		return check_answer(response, row.expect, false);
	};

	const check_upgrade = async (
		row: RequestTargetConformanceWireRow,
		fixture: TestFixture
	): Promise<Array<string>> => {
		const target = fill_request_target_conformance_placeholders(row.target, placeholders);
		const header_lines = principal_lines(row, fixture);
		if (row.expect.status === 101) {
			let client;
			try {
				client = await connect_raw_ws({
					port: Number(url.port),
					hostname: url.hostname,
					host: url.host,
					path: target,
					header_lines
				});
			} catch (error) {
				return [`expected 101: ${error instanceof Error ? error.message : String(error)}`];
			}
			client.destroy();
			return [];
		}
		const { received, response } = await send_raw_upgrade({
			base_url,
			ws_path: target,
			host: url.host,
			header_lines
		});
		if (!response) return [`no whole response (${received.slice(0, 80)})`];
		return check_answer(response, row.expect, !capabilities.ws_refusal_body);
	};

	const run_rows = async (upgrade: boolean): Promise<void> => {
		const fixture = await setup_test();
		assert.strictEqual(
			fixture.extra_actors.length,
			0,
			"the suite's setup_test must seed no extra_actors: the rows carry no usable acting selector"
		);
		const rows = table.wire.filter((row) => (row.upgrade ?? false) === upgrade);
		const failures: Array<string> = [];
		let sent = 0;
		for (const row of rows) {
			if (!backend_serves(row)) continue;
			sent++;
			const label = `${row.name} [${row.method} ${row.target} as ${row.as}, expected ${format_expect(row.expect)}]`;
			const row_failures = upgrade
				? await check_upgrade(row, fixture)
				: await check_request(row, fixture);
			for (const failure of row_failures) failures.push(`${label}: ${failure}`);
		}
		assert.ok(sent > 0, 'the backend serves some of the table’s rows');
		assert.ok(
			failures.length === 0,
			`${failures.length} of ${sent} request target conformance rows disagree:\n${failures.join('\n')}`
		);
	};

	describe('request target conformance on the wire', () => {
		test('every request row answers as the table says', () => run_rows(false));

		test_if(capabilities.ws, 'every WebSocket upgrade row answers as the table says', () =>
			run_rows(true)
		);
	});
};
