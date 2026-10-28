import '../assert_dev_env.ts';

/**
 * Cross-backend front-door contract: what every transport answers before its
 * request reaches per-action dispatch.
 *
 * Each spine composes its front door differently. The TS spine mounts one
 * stack at `/api/*` — body limit, then origin, then session and bearer — and
 * each surface adds its own gates behind it. The Rust spine stacks global
 * layers (body limit, then origin) and has each handler resolve its credential
 * and run its own gates. Two compositions can agree on every per-surface suite
 * and still disagree on which refusal answers when a request trips several, so
 * this suite pins the answer per transport as a table:
 *
 * | surface | foreign `Origin` | unreadable `Origin` | duplicated `Origin` | over cap + foreign `Origin` | no credential | narrowed token |
 * | --- | --- | --- | --- | --- | --- | --- |
 * | REST `POST` (`/logout`) | 403 `forbidden_origin` | 403 `forbidden_origin` | 403 `forbidden_origin` | 413 `payload_too_large` | 401 `authentication_required` | 403 `credential_type_required` |
 * | REST `POST` (`/password`) | — | — | — | — | 401 `authentication_required` | — |
 * | RPC `POST` | 403 `forbidden_origin` | 403 `forbidden_origin` | 403 `forbidden_origin` | 413 `payload_too_large` | 401 `authentication_required` | 403 `token_scope_required` (`rpc:<method>`) |
 * | RPC `GET` | 403 `forbidden_origin` | 403 `forbidden_origin` | 403 `forbidden_origin` | — | 401 `authentication_required` | 403 `token_scope_required` (`rpc:<method>`) |
 * | WS upgrade | 403 `forbidden_origin` | 403 `forbidden_origin` | 403 `forbidden_origin` | — | 401 `authentication_required` | 403 `token_scope_required` (`surface:ws_upgrade`) |
 * | WS path, no upgrade | 403 `forbidden_origin` | — | — | — | 401 `authentication_required` | — |
 * | SSE (audit stream) | 403 `forbidden_origin` | 403 `forbidden_origin` | 403 `forbidden_origin` | — | 401 `authentication_required` | 403 `credential_type_required` |
 *
 * - **foreign `Origin`** carries the keeper's session cookie, so only the
 *   origin check can refuse it — a front door missing that check answers the
 *   surface's success instead.
 * - **unreadable `Origin`** is the allowed origin with a byte past ASCII
 *   (`0xE9`), with the keeper's session — a check that reads such a value as
 *   absent lets it through.
 * - **duplicated `Origin`** sends the allowed origin on two header lines, with
 *   the keeper's session — refused whether a backend sees the two lines (the
 *   Rust spine) or one value joined from them (the TS runtimes), so a check that
 *   reads only the first lets it through.
 * - **over cap + foreign `Origin`** declares a `Content-Length` one byte over
 *   the route's cap — the shared 1 MiB default, or `rpc_max_body_bytes` on the
 *   RPC row — and carries no credential: the cap answers on the header, ahead
 *   of both the origin check and auth. Only the surfaces that take a body have
 *   the column.
 * - **no credential** sends an allowed `Origin` and nothing else.
 * - **WS path, no upgrade** is a `GET` on the WebSocket path with no
 *   `Upgrade` header: the gates answer it as they answer an upgrade, and one
 *   they admit is a 404, as is any method but `GET` (its own cases below the
 *   table).
 * - **narrowed token** sends a bearer minted with a method-scoped scope, and no
 *   `Origin` (a bearer in a browser context is discarded, not refused). The RPC
 *   probe calls a method the scope doesn't name. A narrowed token reaches no
 *   non-RPC surface, but on a session-only surface the credential gate answers
 *   first — the REST probe is session-only `/logout`, and the audit stream is
 *   session-only on both spines.
 *
 * Each case asserts the status and the refusal body: a flat `{error}` (plus
 * its named fields) or, past the RPC front door, the JSON-RPC error envelope
 * with the reason on `error.data.reason`. A WebSocket refusal's body is
 * required where the backend declares `capabilities.ws_refusal_body`; where it
 * doesn't (Node's `@hono/node-ws` drops a refused upgrade's body), an empty
 * body passes on its status and a body that is sent is still asserted.
 *
 * **Transport.** Given a `base_url`, every probe is written to the socket
 * (`raw_http_exchange`): an upgrade has to be, and an over-cap request sends
 * its head alone, as `body_size.ts` explains — the 413 must arrive without a
 * body byte. With `base_url: null` the probes go through the fixture's
 * in-process transport, whole bodies included, and only the WebSocket
 * upgrade rows skip (there is no socket to upgrade): the WebSocket-path rows
 * that ask for no upgrade gate on `capabilities.ws` alone.
 *
 * **Multi-actor upgrade.** One more WS row needs a keeper seeded with a
 * second actor (`extra_actors`), so it runs only given `multi_actor`: a
 * multi-actor keeper's session upgrading with no `?acting=` → 400
 * `actor_required`, the flat body both spines' upgrade-time actor resolution
 * answers. The upgrade resolves an actor there, and a multi-actor account
 * must name one. A backend whose upgrade resolves no actor admits
 * the socket instead; `multi_actor.xfail` runs the row as `xfail_until` for
 * it.
 *
 * Wire it for any backend that serves the spine's account routes, RPC
 * endpoint, WebSocket endpoint and audit stream; the WS and SSE rows gate on
 * `capabilities.ws` and `capabilities.sse`.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { randomBytes } from 'node:crypto';

import { account_verify_action_spec } from '../../auth/account_action_specs.ts';
import {
	ERROR_ACTOR_REQUIRED,
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_CREDENTIAL_TYPE_REQUIRED,
	ERROR_FORBIDDEN_ORIGIN,
	ERROR_PAYLOAD_TOO_LARGE,
	ERROR_TOKEN_SCOPE_REQUIRED
} from '../../http/error_schemas.ts';
import { create_rpc_get_url } from '../rpc_helpers.ts';
import {
	raw_http_exchange,
	raw_http_header_lines,
	raw_http_parse_json,
	raw_http_parse_response,
	RAW_HTTP_READ_TIMEOUT_MS
} from '../transports/raw_http.ts';
import { test_if, type BackendCapabilities } from './capabilities.ts';
import { mint_narrowed_api_token } from './narrowed_api_token.ts';
import type { RpcPathCapabilityGatedCrossSuiteOptions, SetupTest, TestFixture } from './setup.ts';
import {
	SPINE_ACCOUNT_LOGOUT_PATH,
	SPINE_ACCOUNT_PASSWORD_PATH,
	SPINE_BODY_LIMIT_DEFAULT_BYTES,
	SPINE_RPC_PATH,
	SPINE_SSE_PATH,
	SPINE_WS_PATH
} from './spine_surface_constants.ts';
import { xfail_until } from './xfail.ts';

/** A transport's front door, as the table's rows name it. */
export type TransportCompositionSurface =
	'rest_post' | 'rest_password' | 'rpc_post' | 'rpc_get' | 'ws_upgrade' | 'sse';

/** What a probe sends, as the table's columns name it. */
export type TransportCompositionProbe =
	| 'foreign_origin'
	| 'unreadable_origin'
	| 'duplicated_origin'
	| 'over_cap_foreign_origin'
	| 'no_credential'
	| 'narrowed_token'
	| 'multi_actor_no_acting';

/** The refusal a case expects. */
export interface TransportCompositionExpect {
	readonly status: number;
	/** The refusal reason — the flat body's `error`, or the envelope's `error.data.reason`. */
	readonly error: string;
	/** Further fields the refusal must carry, beside the reason. */
	readonly fields?: Readonly<Record<string, unknown>>;
	/** `true` when the refusal is a JSON-RPC error envelope rather than a flat `{error}` body. */
	readonly envelope?: boolean;
}

/** One cell of the front-door table. */
export interface TransportCompositionCase {
	readonly surface: TransportCompositionSurface;
	readonly probe: TransportCompositionProbe;
	readonly expect: TransportCompositionExpect;
	/** The capability the surface needs; the case skips on a backend without it. */
	readonly gate?: keyof BackendCapabilities;
}

/** The RPC method the narrowed token admits. */
const NARROWED_ADMITTED_METHOD = account_verify_action_spec.method;

/**
 * The RPC method the narrowed-token probe calls — one its scope doesn't name.
 * A read with no credential-type or role gate, so the scope gate is the only
 * one that can refuse it, over `GET` as over `POST`.
 */
const NARROWED_REFUSED_METHOD = 'account_session_list';

const FORBIDDEN_ORIGIN: TransportCompositionExpect = { status: 403, error: ERROR_FORBIDDEN_ORIGIN };
const PAYLOAD_TOO_LARGE: TransportCompositionExpect = {
	status: 413,
	error: ERROR_PAYLOAD_TOO_LARGE
};
const SESSION_ONLY: TransportCompositionExpect = {
	status: 403,
	error: ERROR_CREDENTIAL_TYPE_REQUIRED,
	fields: { required_credential_types: ['session'] }
};
const RPC_UNAUTHENTICATED: TransportCompositionExpect = {
	status: 401,
	error: ERROR_AUTHENTICATION_REQUIRED,
	envelope: true
};
const RPC_SCOPE_REFUSED: TransportCompositionExpect = {
	status: 403,
	error: ERROR_TOKEN_SCOPE_REQUIRED,
	fields: { required_scope: `rpc:${NARROWED_REFUSED_METHOD}` },
	envelope: true
};
const UNAUTHENTICATED: TransportCompositionExpect = {
	status: 401,
	error: ERROR_AUTHENTICATION_REQUIRED
};

/** The front-door table — one case per cell of the module doc's matrix. */
export const transport_composition_cases: ReadonlyArray<TransportCompositionCase> = [
	{ surface: 'rest_post', probe: 'foreign_origin', expect: FORBIDDEN_ORIGIN },
	{ surface: 'rest_post', probe: 'unreadable_origin', expect: FORBIDDEN_ORIGIN },
	{ surface: 'rest_post', probe: 'duplicated_origin', expect: FORBIDDEN_ORIGIN },
	{ surface: 'rest_post', probe: 'over_cap_foreign_origin', expect: PAYLOAD_TOO_LARGE },
	{ surface: 'rest_post', probe: 'no_credential', expect: UNAUTHENTICATED },
	{ surface: 'rest_post', probe: 'narrowed_token', expect: SESSION_ONLY },
	// the other session-only REST route that resolves its own credential on the
	// Rust spine, so its 401 is pinned beside `/logout`'s
	{ surface: 'rest_password', probe: 'no_credential', expect: UNAUTHENTICATED },

	{ surface: 'rpc_post', probe: 'foreign_origin', expect: FORBIDDEN_ORIGIN },
	{ surface: 'rpc_post', probe: 'unreadable_origin', expect: FORBIDDEN_ORIGIN },
	{ surface: 'rpc_post', probe: 'duplicated_origin', expect: FORBIDDEN_ORIGIN },
	{ surface: 'rpc_post', probe: 'over_cap_foreign_origin', expect: PAYLOAD_TOO_LARGE },
	{ surface: 'rpc_post', probe: 'no_credential', expect: RPC_UNAUTHENTICATED },
	{ surface: 'rpc_post', probe: 'narrowed_token', expect: RPC_SCOPE_REFUSED },

	{ surface: 'rpc_get', probe: 'foreign_origin', expect: FORBIDDEN_ORIGIN },
	{ surface: 'rpc_get', probe: 'unreadable_origin', expect: FORBIDDEN_ORIGIN },
	{ surface: 'rpc_get', probe: 'duplicated_origin', expect: FORBIDDEN_ORIGIN },
	{ surface: 'rpc_get', probe: 'no_credential', expect: RPC_UNAUTHENTICATED },
	{ surface: 'rpc_get', probe: 'narrowed_token', expect: RPC_SCOPE_REFUSED },

	{ surface: 'ws_upgrade', probe: 'foreign_origin', expect: FORBIDDEN_ORIGIN, gate: 'ws' },
	{ surface: 'ws_upgrade', probe: 'unreadable_origin', expect: FORBIDDEN_ORIGIN, gate: 'ws' },
	{ surface: 'ws_upgrade', probe: 'duplicated_origin', expect: FORBIDDEN_ORIGIN, gate: 'ws' },
	{ surface: 'ws_upgrade', probe: 'no_credential', expect: UNAUTHENTICATED, gate: 'ws' },
	{
		surface: 'ws_upgrade',
		probe: 'narrowed_token',
		expect: {
			status: 403,
			error: ERROR_TOKEN_SCOPE_REQUIRED,
			fields: { required_scope: 'surface:ws_upgrade' }
		},
		gate: 'ws'
	},

	{ surface: 'sse', probe: 'foreign_origin', expect: FORBIDDEN_ORIGIN, gate: 'sse' },
	{ surface: 'sse', probe: 'unreadable_origin', expect: FORBIDDEN_ORIGIN, gate: 'sse' },
	{ surface: 'sse', probe: 'duplicated_origin', expect: FORBIDDEN_ORIGIN, gate: 'sse' },
	{ surface: 'sse', probe: 'no_credential', expect: UNAUTHENTICATED, gate: 'sse' },
	{ surface: 'sse', probe: 'narrowed_token', expect: SESSION_ONLY, gate: 'sse' }
];

/**
 * The rows that need a multi-actor keeper — run only given
 * `TransportCompositionCrossTestOptions.multi_actor`, on its fixture.
 */
export const transport_composition_multi_actor_cases: ReadonlyArray<TransportCompositionCase> = [
	{
		surface: 'ws_upgrade',
		probe: 'multi_actor_no_acting',
		expect: { status: 400, error: ERROR_ACTOR_REQUIRED },
		gate: 'ws'
	}
];

/** The multi-actor rows' fixture, and how a backend known to diverge runs them. */
export interface TransportCompositionMultiActorOptions {
	/** Per-test fixture whose keeper is seeded with at least one `extra_actors` entry. */
	readonly setup_test: SetupTest;
	/** Run the multi-actor rows as `xfail_until` — for a backend known to admit them. */
	readonly xfail?: { readonly tracking_id: string; readonly reason: string };
}

/** Options for `describe_transport_composition_cross_tests`. */
export interface TransportCompositionCrossTestOptions extends RpcPathCapabilityGatedCrossSuiteOptions {
	/**
	 * Base URL the spawned backend is reachable at, or `null` for an in-process
	 * run. Given a URL, every probe is written to the socket; with `null` the
	 * probes go through the fixture's transport and the WebSocket rows skip.
	 */
	readonly base_url: string | null;
	/**
	 * An `Origin` the backend allows. Default: the origin of `base_url`, or
	 * `http://localhost:5173` in-process (which `create_test_app`'s allow list
	 * admits).
	 */
	readonly origin?: string;
	/** Session-only REST `POST` route the REST row probes. Default `/api/account/logout`. */
	readonly rest_path?: string;
	/** Password-change route the `/password` row probes. Default `/api/account/password`. */
	readonly password_path?: string;
	/** WebSocket endpoint path. Default `/api/ws`. */
	readonly ws_path?: string;
	/** Audit-log SSE path. Default `/api/admin/audit/stream`. */
	readonly sse_path?: string;
	/** Run the multi-actor rows (`transport_composition_multi_actor_cases`). */
	readonly multi_actor?: TransportCompositionMultiActorOptions;
	/**
	 * The backend's request-body cap on `rpc_path`, in bytes; the RPC row's
	 * over-cap probe declares a length one past it. Default
	 * `SPINE_BODY_LIMIT_DEFAULT_BYTES`. The REST rows probe past that default,
	 * the cap a backend keeps off its RPC path.
	 */
	readonly rpc_max_body_bytes?: number;
}

/** An `Origin` no backend's allowlist admits. */
const DISALLOWED_ORIGIN = 'http://evil.com';

/** One probe request, before it's put on a transport. */
interface ProbeRequest {
	readonly method: 'GET' | 'POST';
	readonly path: string;
	readonly headers: Record<string, string>;
	/** Headers sent on a line of their own after `headers`, repeating a name `headers` already holds. */
	readonly repeated_headers?: ReadonlyArray<readonly [string, string]>;
	/** The body, or `null`. An over-cap body is sent whole only in-process. */
	readonly body: string | null;
	/** The `Content-Length` to declare, one byte over the route's cap, or `null`. */
	readonly over_cap_length: number | null;
}

/** What a probe read back. */
interface ProbeResponse {
	readonly status: number;
	/** The raw body text — empty when the refusal carried none. */
	readonly text: string;
}

const rpc_envelope = (method: string, id: string): string =>
	JSON.stringify({ jsonrpc: '2.0', method, id });

/** A JSON object body of exactly `bytes` ASCII bytes. */
const sized_json = (bytes: number): string => {
	const base = JSON.stringify({ pad: '' });
	return JSON.stringify({ pad: 'x'.repeat(Math.max(0, bytes - base.length)) });
};

const case_name = (c: TransportCompositionCase): string =>
	`${c.surface} × ${c.probe} → ${c.expect.status} ${c.expect.error}`;

/**
 * Read the refusal reason and fields out of a body, by the shape the case
 * expects. An envelope expectation fails on a flat body and the other way
 * round, so a spine answering from the wrong layer fails here.
 */
const assert_refusal_body = (c: TransportCompositionCase, body: unknown, text: string): void => {
	const label = case_name(c);
	assert.ok(
		body !== null && typeof body === 'object',
		`${label}: expected a JSON body, got ${JSON.stringify(text.slice(0, 200))}`
	);
	let refusal: Record<string, unknown>;
	if (c.expect.envelope) {
		const envelope = body as { jsonrpc?: unknown; error?: { data?: unknown } };
		assert.strictEqual(envelope.jsonrpc, '2.0', `${label}: expected a JSON-RPC envelope: ${text}`);
		const data = envelope.error?.data;
		assert.ok(
			data !== null && typeof data === 'object',
			`${label}: expected error.data on the envelope: ${text}`
		);
		refusal = data as Record<string, unknown>;
		assert.strictEqual(refusal.reason, c.expect.error, `${label}: error.data.reason`);
	} else {
		refusal = body as Record<string, unknown>;
		assert.ok(!('jsonrpc' in refusal), `${label}: expected a flat body, got an envelope: ${text}`);
		assert.strictEqual(refusal.error, c.expect.error, `${label}: body.error`);
	}
	for (const [key, expected] of Object.entries(c.expect.fields ?? {})) {
		assert.deepStrictEqual(refusal[key], expected, `${label}: ${key}`);
	}
};

/**
 * Register the front-door table's cases — one test per cell, each on a fresh
 * fixture.
 *
 * This is the front-door contract: a backend that wires it answers each
 * transport's probes as the table says — when one request trips several
 * refusals, the one the table names answers.
 */
export const describe_transport_composition_cross_tests = (
	options: TransportCompositionCrossTestOptions
): void => {
	const { setup_test, capabilities, base_url } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;
	const rest_path = options.rest_path ?? SPINE_ACCOUNT_LOGOUT_PATH;
	const rpc_max_body_bytes = options.rpc_max_body_bytes ?? SPINE_BODY_LIMIT_DEFAULT_BYTES;
	const password_path = options.password_path ?? SPINE_ACCOUNT_PASSWORD_PATH;
	const ws_path = options.ws_path ?? SPINE_WS_PATH;
	const sse_path = options.sse_path ?? SPINE_SSE_PATH;
	const allowed_origin =
		options.origin ?? (base_url === null ? 'http://localhost:5173' : new URL(base_url).origin);

	/** The request line, headers and body a case's probe sends. */
	const build_probe = async (
		c: TransportCompositionCase,
		fixture: TestFixture
	): Promise<ProbeRequest> => {
		const over_cap = c.probe === 'over_cap_foreign_origin';
		let credential: Record<string, string>;
		let repeated_headers: ReadonlyArray<readonly [string, string]> | undefined;
		switch (c.probe) {
			case 'foreign_origin':
				credential = { ...fixture.create_session_headers(), origin: DISALLOWED_ORIGIN };
				break;
			case 'unreadable_origin':
				// latin1 on the socket — the byte 0xE9
				credential = { ...fixture.create_session_headers(), origin: `${allowed_origin}\u00e9` };
				break;
			case 'duplicated_origin':
				credential = { ...fixture.create_session_headers(), origin: allowed_origin };
				repeated_headers = [['origin', allowed_origin]];
				break;
			case 'over_cap_foreign_origin':
				// no credential either: the cap answers ahead of the origin check and auth
				credential = { origin: DISALLOWED_ORIGIN };
				break;
			case 'no_credential':
				credential = { origin: allowed_origin };
				break;
			case 'multi_actor_no_acting':
				// the multi-actor keeper's session, no `?acting=` on the path
				credential = { ...fixture.create_session_headers(), origin: allowed_origin };
				break;
			case 'narrowed_token': {
				const token = await mint_narrowed_api_token({
					app: fixture.transport,
					rpc_path,
					session_headers: fixture.create_session_headers(),
					methods: [NARROWED_ADMITTED_METHOD]
				});
				// no `Origin` — a bearer in a browser context is discarded
				credential = { authorization: `Bearer ${token}` };
				break;
			}
		}
		const rpc_method =
			c.probe === 'narrowed_token' ? NARROWED_REFUSED_METHOD : account_verify_action_spec.method;
		const id = `${c.surface}-${c.probe}`;
		switch (c.surface) {
			case 'rest_post':
			case 'rest_password':
				return {
					method: 'POST',
					path: c.surface === 'rest_post' ? rest_path : password_path,
					headers: { ...credential, 'content-type': 'application/json' },
					body: over_cap ? sized_json(SPINE_BODY_LIMIT_DEFAULT_BYTES + 1) : '{}',
					over_cap_length: over_cap ? SPINE_BODY_LIMIT_DEFAULT_BYTES + 1 : null,
					repeated_headers
				};
			case 'rpc_post': {
				return {
					method: 'POST',
					path: rpc_path,
					headers: { ...credential, 'content-type': 'application/json' },
					body: over_cap ? sized_json(rpc_max_body_bytes + 1) : rpc_envelope(rpc_method, id),
					over_cap_length: over_cap ? rpc_max_body_bytes + 1 : null,
					repeated_headers
				};
			}
			case 'rpc_get':
				return {
					method: 'GET',
					path: create_rpc_get_url(rpc_path, rpc_method, undefined, id),
					headers: credential,
					body: null,
					over_cap_length: null,
					repeated_headers
				};
			case 'ws_upgrade':
				return {
					method: 'GET',
					path: ws_path,
					headers: {
						...credential,
						upgrade: 'websocket',
						connection: 'Upgrade',
						'sec-websocket-key': randomBytes(16).toString('base64'),
						'sec-websocket-version': '13'
					},
					body: null,
					over_cap_length: null,
					repeated_headers
				};
			case 'sse':
				return {
					method: 'GET',
					path: sse_path,
					headers: { ...credential, accept: 'text/event-stream' },
					body: null,
					over_cap_length: null,
					repeated_headers
				};
		}
	};

	/** Put a probe on the socket, or through the in-process transport. */
	const send_probe = async (fixture: TestFixture, probe: ProbeRequest): Promise<ProbeResponse> => {
		if (base_url === null) {
			const headers = new Headers(probe.headers);
			// in-process there is no wire: a repeated header joins, as the runtimes join it
			for (const [name, value] of probe.repeated_headers ?? []) headers.append(name, value);
			const res = await fixture.fresh_transport()(probe.path, {
				method: probe.method,
				headers,
				...(probe.body === null ? {} : { body: probe.body })
			});
			return { status: res.status, text: await res.text() };
		}
		const url = new URL(base_url);
		const body = probe.over_cap_length === null ? (probe.body ?? '') : '';
		const length_header: Record<string, string> =
			probe.over_cap_length !== null
				? { 'content-length': String(probe.over_cap_length) }
				: probe.body === null
					? {}
					: { 'content-length': String(body.length) };
		const request =
			`${probe.method} ${probe.path} HTTP/1.1\r\n` +
			raw_http_header_lines({ host: url.host, ...probe.headers, ...length_header }) +
			(probe.repeated_headers ?? []).map(([name, value]) => `${name}: ${value}\r\n`).join('') +
			`\r\n` +
			body;
		const { received, closed_by_server } = await raw_http_exchange(base_url, request, {
			read_timeout_ms: RAW_HTTP_READ_TIMEOUT_MS,
			until: 'response'
		});
		const response = raw_http_parse_response(received);
		assert.ok(
			response,
			`${probe.method} ${probe.path}: expected a whole response; ` +
				(closed_by_server
					? 'the server closed the connection first'
					: `none arrived within ${RAW_HTTP_READ_TIMEOUT_MS}ms`) +
				`. Received: ${received ? received.slice(0, 200) : 'nothing'}`
		);
		return { status: response.status, text: response.body };
	};

	const run_case = async (c: TransportCompositionCase, fixture_setup: SetupTest): Promise<void> => {
		const fixture = await fixture_setup();
		const res = await send_probe(fixture, await build_probe(c, fixture));
		assert.strictEqual(
			res.status,
			c.expect.status,
			`${case_name(c)}: status (body: ${res.text.slice(0, 200)})`
		);
		// a backend that declares no WS refusal body (Node's `@hono/node-ws`)
		// may answer with an empty one; a body it does send is still asserted
		if (c.surface === 'ws_upgrade' && !capabilities.ws_refusal_body && res.text === '') return;
		assert_refusal_body(c, raw_http_parse_json(res.text), res.text);
	};
	const is_runnable = (c: TransportCompositionCase): boolean =>
		(c.gate === undefined || capabilities[c.gate]) &&
		// an upgrade needs a socket; in-process there is none
		(c.surface !== 'ws_upgrade' || base_url !== null);

	/** A request on the WebSocket path that asks for no upgrade. */
	const ws_path_probe = (
		method: 'GET' | 'POST',
		credential: Record<string, string>
	): ProbeRequest => ({
		method,
		path: ws_path,
		headers: method === 'POST' ? { ...credential, 'content-type': 'application/json' } : credential,
		body: method === 'POST' ? '{}' : null,
		over_cap_length: null
	});

	describe('transport composition (front door)', () => {
		for (const c of transport_composition_cases) {
			test_if(is_runnable(c), case_name(c), () => run_case(c, setup_test));
		}
		// The WebSocket path serves `GET` alone, and its gates run before the
		// upgrade is looked at: any other method is a 404, a `GET` asking for no
		// upgrade is refused by the gates like an upgrade is, and one the gates
		// admit is a 404 — never an upgrade refusal answered ahead of auth. None
		// of them upgrades, so they run in-process too.
		const ws_runnable = capabilities.ws;
		test_if(ws_runnable, 'ws path × POST with a session → 404', async () => {
			const fixture = await setup_test();
			const res = await send_probe(
				fixture,
				ws_path_probe('POST', { ...fixture.create_session_headers(), origin: allowed_origin })
			);
			assert.strictEqual(res.status, 404, `body: ${res.text.slice(0, 200)}`);
		});
		test_if(ws_runnable, 'ws path × GET without upgrade, no credential → 401', async () => {
			const fixture = await setup_test();
			const res = await send_probe(fixture, ws_path_probe('GET', { origin: allowed_origin }));
			assert.strictEqual(res.status, 401, `body: ${res.text.slice(0, 200)}`);
			assert.strictEqual(
				(raw_http_parse_json(res.text) as { error?: unknown } | null)?.error,
				'authentication_required'
			);
		});
		test_if(ws_runnable, 'ws path × GET without upgrade, foreign origin → 403', async () => {
			const fixture = await setup_test();
			const res = await send_probe(
				fixture,
				ws_path_probe('GET', { ...fixture.create_session_headers(), origin: DISALLOWED_ORIGIN })
			);
			assert.strictEqual(res.status, 403, `body: ${res.text.slice(0, 200)}`);
		});
		test_if(ws_runnable, 'ws path × GET without upgrade, admitted by the gates → 404', async () => {
			const fixture = await setup_test();
			const res = await send_probe(
				fixture,
				ws_path_probe('GET', { ...fixture.create_session_headers(), origin: allowed_origin })
			);
			assert.strictEqual(res.status, 404, `body: ${res.text.slice(0, 200)}`);
		});
		const { multi_actor } = options;
		if (!multi_actor) return;
		for (const c of transport_composition_multi_actor_cases) {
			const name = case_name(c);
			const body = (): Promise<void> => run_case(c, multi_actor.setup_test);
			if (!is_runnable(c)) {
				test_if(false, name, body);
			} else if (multi_actor.xfail) {
				xfail_until(multi_actor.xfail.tracking_id, multi_actor.xfail.reason, name, body);
			} else {
				test(name, body);
			}
		}
	});
};
