import '../assert_dev_env.ts';

/**
 * Cross-backend parity suite for the origin check's scope: every path, not
 * only `/api`.
 *
 * Both spines check the `Origin` of every request — the TS spine mounts the
 * check on every path (`ORIGIN_MIDDLEWARE_PATH`), the Rust spine behind every
 * route group of `fuz_http::compose_stack`, the fallback included — and leave
 * a path out only by a named carve-out with its reason. The front-door table
 * (`transport_composition.ts`) pins the check on the `/api` transports; this
 * suite pins it off `/api`, on the route both spine test servers serve there,
 * `GET /ready`:
 *
 * - **foreign `Origin` → 403 `forbidden_origin`** — the check runs on a path
 *   outside `/api`.
 * - **absent `Origin` → passes** — a probe or CLI client sends none, so the
 *   wider scope costs it nothing.
 * - **allowed `Origin` → passes** — the control: the check admits its own
 *   origin rather than refusing every browser.
 *
 * And on a path neither server routes, which reaches each spine's fallback:
 *
 * - **foreign `Origin` → 403 `forbidden_origin`**, **absent → the fallback's
 *   own answer** — the fallback is behind the check, not attached after it.
 *   The absent row pins that the check let the request through to the
 *   fallback: `404` by default, or `unrouted_status` for a backend whose
 *   fallback serves an SPA shell (`200`).
 * - **an over-cap `POST` with a declared `Content-Length` and a foreign
 *   `Origin` → 413 `payload_too_large`** — the body cap comes ahead of the
 *   origin check on the fallback too (413-first holds for a declared length).
 *
 * The `/ready` rows are gated on `capabilities.ready`, which every spine test
 * server advertises; the unrouted rows run on every backend.
 * Runs both legs via the shared `{setup_test, capabilities}` protocol: the
 * in-process leg (`cross_backend/origin_scope_parity.db.test.ts`, plain `gro
 * test`) and the cross-process leg (`cross_backend/spine_suites.cross.test.ts`,
 * the TS spine binaries + Rust `testing_spine_stub` over real HTTP).
 *
 * @module
 */

import { describe, assert, test } from 'vitest';

import { ERROR_FORBIDDEN_ORIGIN, ERROR_PAYLOAD_TOO_LARGE } from '../../http/error_schemas.ts';
import {
	raw_http_exchange,
	raw_http_parse_response,
	RAW_HTTP_READ_TIMEOUT_MS
} from '../transports/raw_http.ts';
import { test_if } from './capabilities.ts';
import type { CapabilityGatedCrossSuiteOptions } from './setup.ts';
import { SPINE_BODY_LIMIT_DEFAULT_BYTES } from './spine_surface_constants.ts';

/** An origin no spine test server allows. */
const FOREIGN_ORIGIN = 'https://evil.example';

/** A path no spine test server routes — it reaches the fallback. */
const UNROUTED_PATH = '/origin-scope-unrouted';

/** Options for the origin-scope parity suite. */
export interface OriginScopeCrossTestOptions extends CapabilityGatedCrossSuiteOptions {
	/** A public path outside `/api` the backend serves with `200`. Default `/ready`. */
	readonly probe_path?: string;
	/**
	 * The backend's base URL, for the over-cap row: given one, the request
	 * head is written to the socket alone, declaring a length one byte over
	 * the cap, so the `413` has to arrive before any body byte. `null` (the
	 * default) sends the whole body through the fixture's in-process transport.
	 */
	readonly base_url?: string | null;
	/**
	 * The status the backend's fallback answers an unrouted `GET` with, once
	 * the origin check has passed it. Default `404`; a backend serving an SPA
	 * shell from its fallback passes `200`.
	 */
	readonly unrouted_status?: number;
}

export const describe_origin_scope_cross_tests = (options: OriginScopeCrossTestOptions): void => {
	const { setup_test, capabilities } = options;
	const probe_path = options.probe_path ?? '/ready';
	const base_url = options.base_url ?? null;
	const unrouted_status = options.unrouted_status ?? 404;

	describe('origin check scope parity', () => {
		test_if(
			capabilities.ready,
			`a foreign Origin on ${probe_path} → 403 forbidden_origin (the check covers every path)`,
			async () => {
				const fixture = await setup_test();
				// the header set on the request, not as the transport's default — an
				// in-process transport sends no default Origin
				const res = await fixture.fresh_transport({ origin: null })(probe_path, {
					method: 'GET',
					headers: { origin: FOREIGN_ORIGIN }
				});
				assert.strictEqual(res.status, 403, 'a foreign Origin off /api must be refused');
				const body = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
				assert.strictEqual(body?.error, ERROR_FORBIDDEN_ORIGIN);
			}
		);

		test_if(capabilities.ready, `an absent Origin on ${probe_path} → passes`, async () => {
			const fixture = await setup_test();
			const res = await fixture.fresh_transport({ origin: null })(probe_path, { method: 'GET' });
			assert.strictEqual(res.status, 200, 'a request with no Origin must pass the check');
		});

		test_if(capabilities.ready, `the allowed Origin on ${probe_path} → passes`, async () => {
			const fixture = await setup_test();
			// a cross-process transport sends the backend's own, allowed Origin by
			// default (an in-process one sends none, which passes too)
			const res = await fixture.fresh_transport()(probe_path, { method: 'GET' });
			assert.strictEqual(res.status, 200, 'the allowed Origin must pass the check');
		});

		test(`a foreign Origin on an unrouted path → 403 forbidden_origin (the fallback is checked)`, async () => {
			const fixture = await setup_test();
			const res = await fixture.fresh_transport({ origin: null })(UNROUTED_PATH, {
				method: 'GET',
				headers: { origin: FOREIGN_ORIGIN }
			});
			assert.strictEqual(res.status, 403, 'a foreign Origin on the fallback must be refused');
			const body = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
			assert.strictEqual(body?.error, ERROR_FORBIDDEN_ORIGIN);
		});

		test(`an absent Origin on an unrouted path → passes to the fallback (${unrouted_status})`, async () => {
			const fixture = await setup_test();
			const res = await fixture.fresh_transport({ origin: null })(UNROUTED_PATH, {
				method: 'GET'
			});
			assert.strictEqual(
				res.status,
				unrouted_status,
				'a request with no Origin must pass the check and reach the fallback'
			);
		});

		test('an over-cap POST to an unrouted path with a foreign Origin → 413 payload_too_large', async () => {
			const over = SPINE_BODY_LIMIT_DEFAULT_BYTES + 1;
			let status: number;
			let text: string;
			if (base_url === null) {
				const fixture = await setup_test();
				const res = await fixture.fresh_transport({ origin: null })(UNROUTED_PATH, {
					method: 'POST',
					headers: { origin: FOREIGN_ORIGIN, 'content-type': 'application/json' },
					body: 'x'.repeat(over)
				});
				status = res.status;
				text = await res.text();
			} else {
				// the head alone, declaring the length: the 413 must not wait on a body byte
				const url = new URL(base_url);
				const request =
					`POST ${UNROUTED_PATH} HTTP/1.1\r\n` +
					`host: ${url.host}\r\n` +
					`origin: ${FOREIGN_ORIGIN}\r\n` +
					`content-type: application/json\r\n` +
					`content-length: ${over}\r\n` +
					`\r\n`;
				const { received } = await raw_http_exchange(base_url, request, {
					read_timeout_ms: RAW_HTTP_READ_TIMEOUT_MS,
					until: 'response'
				});
				const response = raw_http_parse_response(received);
				assert.ok(response, `no whole response; received: ${received.slice(0, 200)}`);
				status = response.status;
				text = response.body;
			}
			assert.strictEqual(status, 413, `the cap comes ahead of the origin check (body: ${text})`);
			const body = (() => {
				try {
					return JSON.parse(text) as { error?: unknown };
				} catch {
					return undefined;
				}
			})();
			assert.strictEqual(body?.error, ERROR_PAYLOAD_TOO_LARGE);
		});
	});
};
