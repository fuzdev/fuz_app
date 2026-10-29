// @vitest-environment jsdom

/**
 * Tests for `probe_backend` and `BackendProbe` — only the health reply counts
 * as a live backend.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import {
	BACKEND_PROBE_NOT_HEALTH,
	BackendProbe,
	probe_backend
} from '#lib/ui/backend_probe.svelte.ts';
import { HEALTH_PATH, HealthResponse } from '#lib/http/health_schema.ts';
import { create_health_route_spec } from '#lib/http/common_routes.ts';

const json =
	(body: unknown, status = 200) =>
	async (): Promise<Response> =>
		new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' }
		});

describe('probe_backend', () => {
	test('the health reply is a live backend', async () => {
		assert.deepEqual(await probe_backend(json({ status: 'ok' })), { ok: true });
	});

	test("a static SPA fallback's 200 HTML is not a backend", async () => {
		const result = await probe_backend(
			async () =>
				new Response('<!doctype html><html></html>', {
					status: 200,
					headers: { 'content-type': 'text/html' }
				})
		);
		assert.deepEqual(result, { ok: false, error: BACKEND_PROBE_NOT_HEALTH });
	});

	test('a 2xx JSON body that is not the health reply is not a backend', async () => {
		for (const body of [{ status: 'nope' }, null, [], { ok: true }, 'ok']) {
			const result = await probe_backend(json(body));
			assert.deepEqual(
				result,
				{ ok: false, error: BACKEND_PROBE_NOT_HEALTH },
				JSON.stringify(body)
			);
		}
	});

	test('a health reply with an added field is still a live backend', async () => {
		assert.deepEqual(await probe_backend(json({ status: 'ok', version: '1.2.3' })), { ok: true });
	});

	test('a non-2xx is not a backend, even with the health body', async () => {
		assert.deepEqual(await probe_backend(json({ status: 'ok' }, 502)), {
			ok: false,
			error: 'HTTP 502'
		});
	});

	test('a network error is not a backend', async () => {
		const result = await probe_backend(() => Promise.reject(new TypeError('Failed to fetch')));
		assert.deepEqual(result, { ok: false, error: 'Failed to fetch' });
	});

	test('the default fetches the health path', async () => {
		const original = globalThis.fetch;
		const requested: Array<unknown> = [];
		globalThis.fetch = async (input) => {
			requested.push(input);
			return json({ status: 'ok' })();
		};
		try {
			assert.deepEqual(await probe_backend(), { ok: true });
		} finally {
			globalThis.fetch = original;
		}
		assert.deepEqual(requested, [HEALTH_PATH]);
	});
});

describe('probe_backend timeout', () => {
	// a fetch that never answers, rejecting the way a real one does when its signal aborts
	const hanging_fetch = (init?: RequestInit): Promise<Response> =>
		new Promise((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () =>
				reject(new DOMException('timed out', 'TimeoutError'))
			);
		});

	test('the default fetch gives up, reading as down with a clear error', async () => {
		const original = globalThis.fetch;
		globalThis.fetch = async (_input, init) => hanging_fetch(init);
		try {
			assert.deepEqual(await probe_backend(undefined, 20), {
				ok: false,
				error: 'no reply within 20ms'
			});
			const probe = new BackendProbe({ timeout_ms: 20 });
			assert.isFalse(await probe.probe());
			assert.isFalse(probe.reachable);
			assert.strictEqual(probe.error, 'no reply within 20ms');
			assert.isFalse(probe.probing);
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe('health route shares the probe schema', () => {
	test('the route spec serves the path and shape the probe reads', () => {
		const spec = create_health_route_spec();
		assert.strictEqual(spec.path, HEALTH_PATH);
		assert.strictEqual(spec.output, HealthResponse);
	});
});

describe('BackendProbe', () => {
	test('reachable is null until a probe settles, then true for the health reply', async () => {
		const probe = new BackendProbe({ fetch_health: json({ status: 'ok' }) });
		assert.strictEqual(probe.reachable, null);
		assert.isFalse(probe.probing);
		const pending = probe.probe();
		assert.isTrue(probe.probing);
		assert.isTrue(await pending);
		assert.isTrue(probe.reachable);
		assert.strictEqual(probe.error, null);
		assert.isFalse(probe.probing);
	});

	test('a failed probe records why', async () => {
		const probe = new BackendProbe({ fetch_health: json({ status: 'ok' }, 503) });
		assert.isFalse(await probe.probe());
		assert.isFalse(probe.reachable);
		assert.strictEqual(probe.error, 'HTTP 503');
	});

	test('a later probe supersedes one in flight', async () => {
		const slow = Promise.withResolvers<Response>();
		let calls = 0;
		const probe = new BackendProbe({
			fetch_health: () => (++calls === 1 ? slow.promise : json({ status: 'ok' })())
		});
		const first = probe.probe();
		assert.isTrue(await probe.probe());
		assert.isTrue(probe.reachable);
		slow.resolve(new Response('down', { status: 502 }));
		assert.isFalse(await first);
		// the superseded answer is not recorded
		assert.isTrue(probe.reachable);
		assert.strictEqual(probe.error, null);
		assert.isFalse(probe.probing);
	});

	test('a superseded probe settling while the newer is pending changes nothing', async () => {
		const older = Promise.withResolvers<Response>();
		const newer = Promise.withResolvers<Response>();
		let calls = 0;
		const probe = new BackendProbe({
			fetch_health: () => (++calls === 1 ? older.promise : newer.promise)
		});
		const first = probe.probe();
		const second = probe.probe();
		older.resolve(new Response('down', { status: 502 }));
		assert.isFalse(await first);
		// only the newer probe is tracked: still in flight, nothing recorded
		assert.isTrue(probe.probing);
		assert.strictEqual(probe.reachable, null);
		assert.strictEqual(probe.error, null);
		newer.resolve(await json({ status: 'ok' })());
		assert.isTrue(await second);
		assert.isFalse(probe.probing);
		assert.isTrue(probe.reachable);
	});
});
