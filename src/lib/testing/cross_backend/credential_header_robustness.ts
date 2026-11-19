import '../assert_dev_env.ts';

/**
 * Cross-backend **credential-header robustness** probe — the auth sibling of
 * `body_size_smuggling.ts`.
 *
 * What a *control-char-injected* or *oversized* credential header does is
 * framework territory — each spine's HTTP parser decides before the spine
 * reads a byte — so this raw-socket suite asserts the **security invariants
 * that must hold however the parser resolves it**, without blessing one
 * resolution:
 *
 * - **a control-char-injected credential header can't smuggle or authenticate**
 *   — embedded `CRLF` / bare `CR` in the value never frames a second request
 *   (no smuggle) and never authenticates (the truncated / rejected value is no
 *   token).
 * - **no response desync** — each crafted request yields at most one HTTP
 *   response.
 * - **an oversized credential header can't wedge the server** — after a request
 *   with a 64 KiB `X-Daemon-Token` (well past both frameworks' header caps), a
 *   subsequent normal request on a fresh connection still gets a response. The
 *   oversized request's own outcome (4xx / 431 / connection close) is
 *   don't-care; surviving it is the property.
 *
 * A *duplicated* credential header is not here: both spines discard one, and
 * the exact outcome — which credential authenticates, one response — is pinned
 * row by row in `credential_conformance_wire.ts`.
 *
 * Raw-socket by necessity (`fetch` can't emit malformed headers),
 * so — like `body_size_smuggling.ts` — this is **cross-process only** and
 * fixture-free: it needs only the base URL and the RPC path — every
 * credential it sends is garbage. Cited property: `docs/security.md`
 * §"Credential Type Hierarchy" (a leaked / conflicting credential header can't
 * escalate the credential ceiling) + §"API Token Security" (bearer handling).
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { DAEMON_TOKEN_HEADER } from '../../auth/daemon_token.ts';
import {
	raw_http_count_responses,
	raw_http_exchange,
	raw_http_first_status,
	raw_http_request,
	RAW_HTTP_READ_TIMEOUT_MS
} from '../transports/raw_http.ts';
import { SPINE_RPC_PATH } from './spine_surface_constants.ts';

/** Options for the credential-header robustness probe — needs only the raw URL. */
export interface CredentialHeaderRobustnessCrossTestOptions {
	/** Base URL the spawned backend is reachable at (e.g. `http://localhost:1178`). */
	readonly base_url: string;
	/** RPC endpoint path to target. Default `/api/rpc`. */
	readonly rpc_path?: string;
}

/** A well-formed UUID that never names a real row. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** A value that is never a real credential — used for the conflicting / garbage copies. */
const GARBAGE_TOKEN = 'not-a-real-credential-value';

/** Write `request_bytes` to a fresh raw socket and read until the server closes. */
const send_raw = async (base_url: string, request_bytes: string): Promise<string> =>
	(await raw_http_exchange(base_url, request_bytes, { read_timeout_ms: RAW_HTTP_READ_TIMEOUT_MS }))
		.received;

const is_success_status = (status: number): boolean => status >= 200 && status < 300;

/**
 * Frame a raw HTTP/1.1 POST with the given extra header lines + JSON body.
 * `Connection: close` so the server closes after one response (the response
 * count is then unambiguous).
 */
const rpc_post = (
	host: string,
	path: string,
	header_lines: ReadonlyArray<string>,
	body: string
): string =>
	raw_http_request({
		method: 'POST',
		path,
		host,
		header_lines: ['Content-Type: application/json', ...header_lines, 'Connection: close'],
		body
	});

/**
 * A keeper-gated `account_purge` body with `confirm` OMITTED — the confirm
 * guard (`purge_not_confirmed`, before any deletion) guarantees the
 * valid-credential branch is a non-2xx with zero side effect, so the
 * no-escalation assertion holds regardless of which duplicate header wins.
 */
const purge_body = (id: string): string =>
	JSON.stringify({ jsonrpc: '2.0', method: 'account_purge', id, params: { account_id: NIL_UUID } });

export const describe_credential_header_robustness_cross_tests = (
	options: CredentialHeaderRobustnessCrossTestOptions
): void => {
	const { base_url } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;
	const host = new URL(base_url).host;

	describe('credential-header robustness', () => {
		test('control-char-injected credential header (CR/LF) cannot smuggle or authenticate', async () => {
			// Embedded CRLF and a bare CR (header-splitting attempts) in a garbage
			// `X-Daemon-Token` value. A strict HTTP parser rejects the request
			// (400 / connection close); a lenient one truncates the value to a
			// non-token or treats the injected line as an extra (harmless) header.
			// Either way the framework-agnostic invariants hold: the injected bytes
			// never frame a SECOND request (no smuggle), and the garbage credential
			// never authenticates (no 2xx). `<= 1` (not `=== 1`) because a strict
			// parser may close without a readable response — that's also "no smuggle".
			const malformed: ReadonlyArray<{ readonly label: string; readonly value: string }> = [
				{ label: 'CRLF header-split', value: `${GARBAGE_TOKEN}\r\nX-Injected: 1` },
				{ label: 'bare CR', value: `${GARBAGE_TOKEN}\rX-Injected: 1` }
			];
			for (const { label, value } of malformed) {
				const req = rpc_post(
					host,
					rpc_path,
					[`${DAEMON_TOKEN_HEADER}: ${value}`],
					purge_body('ctrl-char')
				);
				const raw = await send_raw(base_url, req);
				assert.ok(
					raw_http_count_responses(raw) <= 1,
					`${label}: a control-char-injected credential header must not frame a second ` +
						`request (no smuggle). Raw head: ${raw.slice(0, 120)}`
				);
				const status = raw_http_first_status(raw);
				assert.ok(
					status === null || !is_success_status(status),
					`${label}: a malformed credential header must never authenticate (got ${status})`
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
				purge_body('oversized')
			);
			await send_raw(base_url, req);

			// The property: the server survives it. A normal request on a fresh
			// connection must still get a response (no crash, no wedged accept loop).
			const probe = `GET ${rpc_path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`;
			const raw = await send_raw(base_url, probe);
			assert.ok(
				raw_http_first_status(raw) !== null,
				`server must still respond after an oversized-header request (no crash / wedge). Raw head: ${raw.slice(
					0,
					120
				)}`
			);
		});
	});
};
