import '../assert_dev_env.ts';

/**
 * Cross-backend **credential-header robustness** probe — the auth sibling of
 * `body_size_smuggling.ts`.
 *
 * The auth middleware reads a single credential per header (`Authorization`,
 * `X-Daemon-Token`). What a *duplicated*, *oversized*, or *control-char-injected*
 * credential header does is framework-territory — Hono reads its headers via the
 * Web `Headers` API, axum via `http::HeaderMap` — and the two could resolve a
 * duplicate differently (first-vs-last), cap header size differently, or parse a
 * malformed value differently. None of that is exercised over `fetch` (the
 * `FetchTransport` can't emit a duplicate or malformed header), so it had no
 * cross-impl pin. This raw-socket suite sends hand-framed requests and asserts
 * the **security invariants that must hold regardless of how each framework
 * resolves the ambiguity** — so it pins a real property without blessing one
 * resolution over the other:
 *
 * - **a duplicated credential header never escalates** — a request carrying a
 *   valid keeper `X-Daemon-Token` *and* a second, conflicting one must not
 *   perform a keeper operation. The target omits `confirm`, so the documented
 *   confirm guard (`purge_not_confirmed`) makes the honored-token branch a
 *   guaranteed non-2xx with **zero side effect**, and the discarded-token
 *   branch is a non-2xx auth/credential refusal — so whichever copy the
 *   framework picks, the outcome is non-2xx. The same shape with two garbage
 *   `Authorization` headers pins the bearer path can't be escalated either.
 * - **a control-char-injected credential header can't smuggle or authenticate**
 *   — embedded `CRLF` / bare `CR` in the value never frames a second request
 *   (no smuggle) and never authenticates (the truncated / rejected value is no
 *   token).
 * - **no response desync** — each crafted request yields exactly one HTTP
 *   response (a duplicate header that reframed the request would surface as a
 *   second status line, like the body-size smuggling probe).
 * - **an oversized credential header can't wedge the server** — after a request
 *   with a 64 KiB `X-Daemon-Token` (well past both frameworks' header caps), a
 *   subsequent normal request on a fresh connection still gets a response. The
 *   oversized request's own outcome (4xx / 431 / connection close) is
 *   don't-care; surviving it is the property.
 *
 * Raw-socket by necessity (`fetch` can't emit duplicate or malformed headers),
 * so — like `body_size_smuggling.ts` — this is **cross-process only** and
 * fixture-free: it needs only the base URL, the RPC path, and a valid daemon
 * token (`handle.daemon_token`, kept current for the run by the same rotation
 * the `_testing_reset` channel relies on). Cited property: `docs/security.md`
 * §"Credential Type Hierarchy" (a leaked / conflicting credential header can't
 * escalate the credential ceiling) + §"API Token Security" (bearer handling).
 *
 * `$lib`-free by contract (relative + `node:` specifiers only).
 *
 * @module
 */

import {connect} from 'node:net';

import {describe, test, assert} from 'vitest';

import {DAEMON_TOKEN_HEADER} from '../../auth/daemon_token.ts';
import {SPINE_RPC_PATH} from './spine_surface_constants.ts';

/** Options for the credential-header robustness probe — needs the raw URL + a valid daemon token. */
export interface CredentialHeaderRobustnessCrossTestOptions {
	/** Base URL the spawned backend is reachable at (e.g. `http://localhost:1178`). */
	readonly base_url: string;
	/** RPC endpoint path to target. Default `/api/rpc`. */
	readonly rpc_path?: string;
	/** A valid daemon token (keeper) — `handle.daemon_token`. */
	readonly daemon_token: string;
}

/** A well-formed UUID that never names a real row. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** A value that is never a real credential — used for the conflicting / garbage copies. */
const GARBAGE_TOKEN = 'not-a-real-credential-value';

/**
 * Open a raw TCP socket to `base_url`, write `request_bytes` once, and collect
 * everything the server sends back until it closes or `read_timeout_ms`
 * elapses. Write errors are swallowed (a server closing mid-write on a rejected
 * request is expected behavior); what matters is what we read back. Mirrors
 * `body_size_smuggling.ts`'s `send_raw`.
 */
const send_raw = (
	base_url: string,
	request_bytes: string,
	read_timeout_ms: number,
): Promise<string> =>
	new Promise((resolve) => {
		const url = new URL(base_url);
		const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
		const socket = connect({host: url.hostname, port});
		let received = '';
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(received);
		};
		const timer = setTimeout(finish, read_timeout_ms);
		socket.setEncoding('latin1');
		socket.on('connect', () => socket.write(request_bytes));
		socket.on('data', (chunk: string) => {
			received += chunk;
		});
		socket.on('error', () => {}); // EPIPE/ECONNRESET on mid-write close is expected
		socket.on('close', finish);
	});

/**
 * Count HTTP response status lines in a raw byte stream. Unanchored so a
 * second (smuggled) response concatenated after the first body — which carries
 * no trailing newline — is still counted; see `body_size_smuggling.ts`.
 */
const count_responses = (raw: string): number => (raw.match(/HTTP\/1\.[01] \d{3}/g) ?? []).length;

/** The status code of the first HTTP response in a raw stream, or `null` if none. */
const first_status = (raw: string): number | null => {
	const match = /HTTP\/1\.[01] (\d{3})/.exec(raw);
	return match ? Number(match[1]) : null;
};

const is_success_status = (status: number): boolean => status >= 200 && status < 300;

/**
 * Frame a raw HTTP/1.1 POST with the given extra header lines + JSON body.
 * `Connection: close` so the server closes after one response (the response
 * count is then unambiguous). The body is ASCII JSON, so `body.length` is the
 * byte length — no `Buffer` needed.
 */
const rpc_post = (
	host: string,
	path: string,
	header_lines: ReadonlyArray<string>,
	body: string,
): string =>
	`POST ${path} HTTP/1.1\r\n` +
	`Host: ${host}\r\n` +
	`Content-Type: application/json\r\n` +
	header_lines.map((h) => `${h}\r\n`).join('') +
	`Content-Length: ${body.length}\r\n` +
	`Connection: close\r\n` +
	`\r\n` +
	body;

/**
 * A keeper-gated `account_purge` body with `confirm` OMITTED — the confirm
 * guard (`purge_not_confirmed`, before any deletion) guarantees the
 * valid-credential branch is a non-2xx with zero side effect, so the
 * no-escalation assertion holds regardless of which duplicate header wins.
 */
const purge_body = (id: string): string =>
	JSON.stringify({jsonrpc: '2.0', method: 'account_purge', id, params: {account_id: NIL_UUID}});

export const describe_credential_header_robustness_cross_tests = (
	options: CredentialHeaderRobustnessCrossTestOptions,
): void => {
	const {base_url, daemon_token} = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;
	const host = new URL(base_url).host;

	describe('credential-header robustness', () => {
		test('duplicate X-Daemon-Token (valid + conflicting) never escalates → one non-2xx response', async () => {
			const req = rpc_post(
				host,
				rpc_path,
				[`${DAEMON_TOKEN_HEADER}: ${daemon_token}`, `${DAEMON_TOKEN_HEADER}: ${GARBAGE_TOKEN}`],
				purge_body('dup-daemon'),
			);
			const raw = await send_raw(base_url, req, 2000);
			assert.strictEqual(
				count_responses(raw),
				1,
				`a duplicated X-Daemon-Token must yield exactly one response (no desync). Raw head: ${raw.slice(
					0,
					120,
				)}`,
			);
			const status = first_status(raw);
			assert.ok(status !== null, `expected an HTTP response. Raw head: ${raw.slice(0, 120)}`);
			assert.ok(
				!is_success_status(status),
				`a duplicated daemon token must not perform a keeper operation; whichever copy wins, ` +
					`the result must be non-2xx (got ${status})`,
			);
		});

		test('duplicate Authorization bearer headers (both garbage) do not authenticate → one non-2xx response', async () => {
			const req = rpc_post(
				host,
				rpc_path,
				[`Authorization: Bearer ${GARBAGE_TOKEN}`, `Authorization: Bearer ${GARBAGE_TOKEN}-2`],
				purge_body('dup-bearer'),
			);
			const raw = await send_raw(base_url, req, 2000);
			assert.strictEqual(
				count_responses(raw),
				1,
				`duplicate Authorization headers must yield exactly one response (no desync). Raw head: ${raw.slice(
					0,
					120,
				)}`,
			);
			const status = first_status(raw);
			assert.ok(status !== null, `expected an HTTP response. Raw head: ${raw.slice(0, 120)}`);
			assert.ok(
				!is_success_status(status),
				`garbage bearer tokens (even duplicated) must not authenticate (got ${status})`,
			);
		});

		test('control-char-injected credential header (CR/LF) cannot smuggle or authenticate', async () => {
			// Embedded CRLF and a bare CR (header-splitting attempts) in a garbage
			// `X-Daemon-Token` value. A strict HTTP parser rejects the request
			// (400 / connection close); a lenient one truncates the value to a
			// non-token or treats the injected line as an extra (harmless) header.
			// Either way the framework-agnostic invariants hold: the injected bytes
			// never frame a SECOND request (no smuggle), and the garbage credential
			// never authenticates (no 2xx). `<= 1` (not `=== 1`) because a strict
			// parser may close without a readable response — that's also "no smuggle".
			const malformed: ReadonlyArray<{readonly label: string; readonly value: string}> = [
				{label: 'CRLF header-split', value: `${GARBAGE_TOKEN}\r\nX-Injected: 1`},
				{label: 'bare CR', value: `${GARBAGE_TOKEN}\rX-Injected: 1`},
			];
			for (const {label, value} of malformed) {
				const req = rpc_post(
					host,
					rpc_path,
					[`${DAEMON_TOKEN_HEADER}: ${value}`],
					purge_body('ctrl-char'),
				);
				const raw = await send_raw(base_url, req, 2000);
				assert.ok(
					count_responses(raw) <= 1,
					`${label}: a control-char-injected credential header must not frame a second ` +
						`request (no smuggle). Raw head: ${raw.slice(0, 120)}`,
				);
				const status = first_status(raw);
				assert.ok(
					status === null || !is_success_status(status),
					`${label}: a malformed credential header must never authenticate (got ${status})`,
				);
			}
		});

		test('oversized credential header does not crash or wedge the server', async () => {
			// 64 KiB — well past both frameworks' header-size caps, so the request is
			// rejected (4xx / 431 / connection close). Its own outcome is don't-care.
			const oversized = 'a'.repeat(64 * 1024);
			const req = rpc_post(
				host,
				rpc_path,
				[`${DAEMON_TOKEN_HEADER}: ${oversized}`],
				purge_body('oversized'),
			);
			await send_raw(base_url, req, 2000);

			// The property: the server survives it. A normal request on a fresh
			// connection must still get a response (no crash, no wedged accept loop).
			const probe = `GET ${rpc_path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`;
			const raw = await send_raw(base_url, probe, 2000);
			assert.ok(
				first_status(raw) !== null,
				`server must still respond after an oversized-header request (no crash / wedge). Raw head: ${raw.slice(
					0,
					120,
				)}`,
			);
		});
	});
};
