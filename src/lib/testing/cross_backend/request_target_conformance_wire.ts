import '../assert_dev_env.ts';

/**
 * The request target conformance table over raw sockets: each `wire` row of
 * `request_target_conformance.json` sent to the live backend with its target
 * written byte for byte, and the answer's status, error code and — on a
 * JSON-RPC answer — envelope `id`, error code and `data.reason` asserted,
 * with the `Allow` methods, a plain-text body, a `HEAD` answer's media type
 * and the session cookie's clear where the row pins them.
 *
 * Where the unit legs run each spine's strict readers over a query string or
 * a path segment, this sends the target: the runtime's request-line parser,
 * its URL, the router and the route's own phases sit between the bytes and
 * the answer, so it is what proves every surface that reads the query or the
 * path params reads them through the strict readers, in the phase order the
 * row pins, and that both routers answer a method a path doesn't serve, and
 * a path nothing serves, alike. A fetch client can't send these targets — it would re-encode
 * them — so the leg is raw-socket, and **cross-process only**. It needs no
 * backdoor.
 *
 * A row is sent by its principal (`keeper_session`: the fixture's keeper
 * cookie; `none`: no credential; `invalid_session`: the session cookie's name
 * with a value that doesn't verify), with its `origin` as the one `Origin`
 * line or none, its `host` in place of the backend's `Host`, and its
 * `headers` as written. The rows run as one test per set of capabilities
 * they require, each skipped — visibly — on a backend not declaring every
 * one: a backend serving a fallback of its own outside `/api`
 * (`spine_fallback: false`) skips the rows that land there and runs the
 * rest. A row
 * holding `expect_where_dot_segments_resolved` expects that answer on a
 * backend whose runtime resolves dot segments
 * (`capabilities.runtime_resolves_dot_segments`) and its `expect` on one
 * whose router reads the raw path. A `HEAD` row's answer must carry no body.
 * An `upgrade` row is a WebSocket upgrade (`capabilities.ws`): a `101` is the
 * handshake accepted, and a refusal's code is read where the runtime sends
 * its body (`capabilities.ws_refusal_body`).
 *
 * **What it needs of a backend**: the spine's RPC endpoint with
 * `account_verify` on `rpc_path`, the account status and login routes, the
 * WebSocket endpoint on `ws_path`, the audit stream on `sse_path`, `GET` alone
 * on `health_path`, nothing else at the paths its routing rows name as
 * unmatched, and the fact routes at `/api/facts/:hash` and
 * `/api/cells/:cell_id/facts/:hash`, each as its capability declares, and a
 * single-actor keeper (no `extra_actors`) that holds the WebSocket upgrade's
 * roles.
 *
 * @module
 */

import { assert, describe } from 'vitest';

import {
	raw_http_error_code,
	raw_http_exchange,
	raw_http_header_values,
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
	SPINE_ACCOUNT_LOGIN_PATH,
	SPINE_ACCOUNT_STATUS_PATH,
	SPINE_RPC_PATH,
	SPINE_SSE_PATH,
	SPINE_WS_PATH
} from './spine_surface_constants.ts';

/** Options for `describe_request_target_conformance_wire_cross_tests`. */
export interface RequestTargetConformanceWireCrossTestOptions {
	/** Per-test fixture producer (cross-process), seeding no `extra_actors`. */
	readonly setup_test: SetupTest;
	/**
	 * `ws`, `sse`, `account_status`, `fact_serving`,
	 * `fact_serving_admin_hash` and `spine_fallback` gate the rows that require
	 * them;
	 * `ws_refusal_body` whether a refused upgrade's code is read, and
	 * `runtime_resolves_dot_segments` which answer a dot-segment row expects.
	 */
	readonly capabilities: BackendCapabilities;
	/** Base URL the spawned backend is reachable at (e.g. `http://localhost:1178`). */
	readonly base_url: string;
	/** JSON-RPC endpoint path. Default `SPINE_RPC_PATH`. */
	readonly rpc_path?: string;
	/** WebSocket endpoint path. Default `SPINE_WS_PATH`. */
	readonly ws_path?: string;
	/** Login route path, the `POST`-only route. Default `SPINE_ACCOUNT_LOGIN_PATH`. */
	readonly account_login_path?: string;
	/** Audit stream path, the SSE route. Default `SPINE_SSE_PATH`. */
	readonly sse_path?: string;
	/** Health probe path, the route outside the auth scope. Default `/health`. */
	readonly health_path?: string;
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
		expect.allow && `Allow {${expect.allow.join(',')}}`,
		expect.text !== undefined && `text ${JSON.stringify(expect.text)}`,
		expect.media,
		expect.jsonrpc && `id ${JSON.stringify(expect.jsonrpc.id)}`,
		expect.jsonrpc?.code,
		expect.jsonrpc?.reason
	]
		.filter((part) => part !== undefined && part !== false)
		.join(' ');

/** The `Allow` header's methods, upper-cased and sorted, or `[]` without one. */
const read_allow = (response: RawHttpResponse): Array<string> =>
	(response.headers.allow ?? '')
		.split(',')
		.map((method) => method.trim().toUpperCase())
		.filter((method) => method !== '')
		.sort();

/** The kind of a response's `Content-Type`, by its essence. */
const read_media = (response: RawHttpResponse): string => {
	const essence = (response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
	if (essence === 'application/json') return 'json';
	if (essence === 'text/plain') return 'text';
	return essence === '' ? '(none)' : essence;
};

/** What `check_answer` reads beside the parsed response. */
interface AnswerContext {
	/** The runtime may drop a refusal's body (a Node upgrade refusal). */
	readonly body_optional: boolean;
	/** The request was a `HEAD`: the answer must carry no body. */
	readonly head_request: boolean;
	/** Every `Set-Cookie` line of the answer, in order. */
	readonly set_cookies: ReadonlyArray<string>;
	/** The backend's session cookie name. */
	readonly cookie_name: string;
}

/** Hold one answer to its row's `expect`. */
const check_answer = (
	response: RawHttpResponse,
	expect: RequestTargetConformanceExpect,
	context: AnswerContext
): Array<string> => {
	const got = `got ${response.status} (${utf8_body(response).slice(0, 120)})`;
	if (response.status !== expect.status) return [`expected status ${expect.status}, ${got}`];
	const failures: Array<string> = [];
	if (expect.allow !== undefined) {
		const allow = read_allow(response);
		const expected = [...expect.allow].sort();
		if (allow.join(',') !== expected.join(',')) {
			failures.push(`expected Allow {${expected.join(',')}}, got {${allow.join(',')}} (${got})`);
		}
	}
	if (expect.clears_session !== undefined) {
		const clears = context.set_cookies.some(
			(line) => line.startsWith(`${context.cookie_name}=;`) && /;\s*Max-Age=0(?:;|$)/i.test(line)
		);
		if (clears !== expect.clears_session) {
			failures.push(
				`expected ${expect.clears_session ? 'the session cookie cleared' : 'no session clear'}, got Set-Cookie ${JSON.stringify(context.set_cookies)}`
			);
		}
	}
	if (expect.media !== undefined && read_media(response) !== expect.media) {
		failures.push(`expected a ${expect.media} Content-Type, got ${read_media(response)}`);
	}
	if (context.head_request) {
		if (response.body !== '') failures.push(`expected no body on a HEAD answer, ${got}`);
		return failures;
	}
	if (context.body_optional && response.body === '') return failures;
	if (expect.text !== undefined) {
		if (read_media(response) !== 'text') {
			failures.push(`expected a text Content-Type, got ${read_media(response)}`);
		}
		if (utf8_body(response) !== expect.text) {
			failures.push(`expected the body ${JSON.stringify(expect.text)}, ${got}`);
		}
	}
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
		// the spine's, as `query_shape` and `token_scope_surface` send to and the
		// mount suite probes: the one path `capabilities.account_status` names
		account_status_path: SPINE_ACCOUNT_STATUS_PATH,
		account_login_path: options.account_login_path ?? SPINE_ACCOUNT_LOGIN_PATH,
		sse_path: options.sse_path ?? SPINE_SSE_PATH,
		health_path: options.health_path ?? '/health'
	};
	const table = load_request_target_conformance();

	/** The answer a row expects of this backend. */
	const expected = (row: RequestTargetConformanceWireRow): RequestTargetConformanceExpect =>
		capabilities.runtime_resolves_dot_segments && row.expect_where_dot_segments_resolved
			? row.expect_where_dot_segments_resolved
			: row.expect;

	/** The session cookie's `name=value` the fixture sends. */
	const session_cookie = (fixture: TestFixture): string => {
		const cookie = fixture.create_session_headers().cookie;
		if (!cookie?.includes('=')) throw new Error('the fixture sends its session as one cookie pair');
		return cookie;
	};

	/** The header lines a row's principal and its `origin` send. */
	const principal_lines = (
		row: RequestTargetConformanceWireRow,
		fixture: TestFixture
	): Array<string> => {
		const lines =
			row.as === 'none'
				? []
				: row.as === 'invalid_session'
					? [`cookie: ${session_cookie(fixture).split('=')[0]}=invalid`]
					: Object.entries(fixture.create_session_headers()).map(
							([name, value]) => `${name}: ${value}`
						);
		if (row.origin !== undefined) lines.push(`origin: ${row.origin}`);
		return row.headers === undefined ? lines : [...lines, ...row.headers];
	};

	const check_request = async (
		row: RequestTargetConformanceWireRow,
		fixture: TestFixture
	): Promise<Array<string>> => {
		const { received } = await raw_http_exchange(
			base_url,
			raw_http_request({
				method: row.method,
				path: fill_request_target_conformance_placeholders(row.target, placeholders),
				host: row.host ?? url.host,
				header_lines: [...principal_lines(row, fixture), 'Connection: close']
			}),
			{ read_timeout_ms: RAW_HTTP_READ_TIMEOUT_MS }
		);
		const head_request = row.method === 'HEAD';
		const response = raw_http_parse_response(received, { head_request });
		if (!response) return [`no whole response (${received.slice(0, 80)})`];
		return check_answer(response, expected(row), {
			body_optional: false,
			head_request,
			set_cookies: raw_http_header_values(received, 'set-cookie'),
			cookie_name: session_cookie(fixture).split('=')[0]!
		});
	};

	const check_upgrade = async (
		row: RequestTargetConformanceWireRow,
		fixture: TestFixture
	): Promise<Array<string>> => {
		const target = fill_request_target_conformance_placeholders(row.target, placeholders);
		const host = row.host ?? url.host;
		const header_lines = principal_lines(row, fixture);
		if (expected(row).status === 101) {
			let client;
			try {
				client = await connect_raw_ws({
					port: Number(url.port),
					hostname: url.hostname,
					host,
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
			host,
			header_lines
		});
		if (!response) return [`no whole response (${received.slice(0, 80)})`];
		return check_answer(response, expected(row), {
			body_optional: !capabilities.ws_refusal_body,
			head_request: false,
			set_cookies: raw_http_header_values(received, 'set-cookie'),
			cookie_name: session_cookie(fixture).split('=')[0]!
		});
	};

	const run_rows = async (
		rows: ReadonlyArray<RequestTargetConformanceWireRow>,
		upgrade: boolean
	): Promise<void> => {
		const fixture = await setup_test();
		assert.strictEqual(
			fixture.extra_actors.length,
			0,
			"the suite's setup_test must seed no extra_actors: the rows carry no usable acting selector"
		);
		const failures: Array<string> = [];
		for (const row of rows) {
			const label = `${row.name} [${row.method} ${row.target} as ${row.as}${row.origin ? ` from ${row.origin}` : ''}, expected ${format_expect(expected(row))}]`;
			const row_failures = upgrade
				? await check_upgrade(row, fixture)
				: await check_request(row, fixture);
			for (const failure of row_failures) failures.push(`${label}: ${failure}`);
		}
		assert.ok(
			failures.length === 0,
			`${failures.length} of ${rows.length} request target conformance rows disagree:\n${failures.join('\n')}`
		);
	};

	/** The rows of one kind grouped by the capabilities they require, the unrequiring group first. */
	const group_rows = (upgrade: boolean): Map<string, Array<RequestTargetConformanceWireRow>> => {
		const groups: Map<string, Array<RequestTargetConformanceWireRow>> = new Map([['', []]]);
		for (const row of table.wire) {
			if ((row.upgrade ?? false) !== upgrade) continue;
			const key = [...new Set(row.requires)].sort().join(' + ');
			let group = groups.get(key);
			if (!group) groups.set(key, (group = []));
			group.push(row);
		}
		return groups;
	};

	describe('request target conformance on the wire', () => {
		for (const upgrade of [false, true]) {
			const kind = upgrade ? 'WebSocket upgrade row' : 'request row';
			for (const [key, rows] of group_rows(upgrade)) {
				if (rows.length === 0) continue;
				const required = rows[0]!.requires ?? [];
				test_if(
					(!upgrade || capabilities.ws) &&
						required.every((requirement) => capabilities[requirement]),
					key === ''
						? `every ${kind} answers as the table says`
						: `every ${kind} requiring ${key} answers as the table says`,
					() => run_rows(rows, upgrade)
				);
			}
		}
	});
};
