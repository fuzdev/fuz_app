// @vitest-environment jsdom

/**
 * Tests for `probe_backend` and `BackendProbe` — only the health reply counts
 * as a live backend.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import {
	BACKEND_PROBE_ABORTED,
	BACKEND_PROBE_NOT_HEALTH,
	BackendProbe,
	probe_backend,
	type BackendProbeOptions
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

// swap `globalThis.fetch` for the default fetch's tests, restoring it after
const with_fetch = async <T>(mock: typeof fetch, fn: () => Promise<T>): Promise<T> => {
	const original = globalThis.fetch;
	globalThis.fetch = mock;
	try {
		return await fn();
	} finally {
		globalThis.fetch = original;
	}
};

describe('probe_backend', () => {
	test('the health reply is a live backend', async () => {
		assert.deepEqual(await probe_backend({ fetch_health: json({ status: 'ok' }) }), { ok: true });
	});

	test("a static SPA fallback's 200 HTML is not a backend", async () => {
		const result = await probe_backend({
			fetch_health: async () =>
				new Response('<!doctype html><html></html>', {
					status: 200,
					headers: { 'content-type': 'text/html' }
				})
		});
		assert.deepEqual(result, { ok: false, error: BACKEND_PROBE_NOT_HEALTH });
	});

	test('a 2xx JSON body that is not the health reply is not a backend', async () => {
		for (const body of [{ status: 'nope' }, null, [], { ok: true }, 'ok']) {
			const result = await probe_backend({ fetch_health: json(body) });
			assert.deepEqual(
				result,
				{ ok: false, error: BACKEND_PROBE_NOT_HEALTH },
				JSON.stringify(body)
			);
		}
	});

	test('a health reply with an added field is still a live backend', async () => {
		assert.deepEqual(
			await probe_backend({ fetch_health: json({ status: 'ok', version: '1.2.3' }) }),
			{ ok: true }
		);
	});

	test('a non-2xx is not a backend, even with the health body', async () => {
		assert.deepEqual(await probe_backend({ fetch_health: json({ status: 'ok' }, 502) }), {
			ok: false,
			error: 'HTTP 502'
		});
	});

	test('a network error is not a backend', async () => {
		const result = await probe_backend({
			fetch_health: () => Promise.reject(new TypeError('Failed to fetch'))
		});
		assert.deepEqual(result, { ok: false, error: 'Failed to fetch' });
	});

	test('a body read cut short by a dropped connection reports the error', async () => {
		const result = await probe_backend({
			fetch_health: async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.error(new TypeError('terminated'));
						}
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				)
		});
		assert.deepEqual(result, { ok: false, error: 'terminated' });
	});

	test('the default fetches the health path', async () => {
		const before = globalThis.fetch;
		const requested: Array<unknown> = [];
		const result = await with_fetch(
			async (input) => {
				requested.push(input);
				return json({ status: 'ok' })();
			},
			() => probe_backend()
		);
		assert.deepEqual(result, { ok: true });
		assert.deepEqual(requested, [HEALTH_PATH]);
		// the swap never outlives its test
		assert.strictEqual(globalThis.fetch, before);
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
		await with_fetch(
			async (_input, init) => hanging_fetch(init),
			async () => {
				assert.deepEqual(await probe_backend({ timeout_ms: 20 }), {
					ok: false,
					error: 'no reply within 20ms'
				});
				const probe = new BackendProbe({ timeout_ms: 20 });
				assert.isFalse(await probe.probe());
				assert.isFalse(probe.reachable);
				assert.strictEqual(probe.error, 'no reply within 20ms');
				assert.isFalse(probe.probing);
			}
		);
	});

	test('a timeout while the default fetch reads the body reports the timeout', async () => {
		// headers arrive, then the body stalls until the signal aborts
		const result = await with_fetch(
			async (_input, init) =>
				new Response(
					new ReadableStream({
						start(controller) {
							init?.signal?.addEventListener('abort', () =>
								controller.error(new DOMException('timed out', 'TimeoutError'))
							);
						}
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				),
			() => probe_backend({ timeout_ms: 20 })
		);
		assert.deepEqual(result, { ok: false, error: 'no reply within 20ms' });
	});

	test("an injected fetch's timeout does not claim the default timeout", async () => {
		const result = await probe_backend({
			fetch_health: () => Promise.reject(new DOMException('timed out', 'TimeoutError')),
			timeout_ms: 20
		});
		assert.deepEqual(result, { ok: false, error: 'timed out' });
	});
});

describe('probe_backend signal', () => {
	// a fetch that never answers, rejecting with its signal's reason when it aborts, as a real one does
	const hanging_fetch = (init?: RequestInit): Promise<Response> =>
		new Promise((_resolve, reject) => {
			const signal = init?.signal;
			// a real fetch rejects with the reason as given, Error or not
			// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
			signal?.addEventListener('abort', () => reject(signal.reason));
		});

	test("the caller's abort cancels the default fetch and reports an abort", async () => {
		const controller = new AbortController();
		let fetch_signal: AbortSignal | null | undefined;
		const result = await with_fetch(
			async (_input, init) => {
				fetch_signal = init?.signal;
				return hanging_fetch(init);
			},
			async () => {
				const pending = probe_backend({ signal: controller.signal, timeout_ms: 1_000 });
				controller.abort();
				// the default fetch's own signal aborts with the caller's, not at its timeout
				assert.isTrue(fetch_signal?.aborted);
				return pending;
			}
		);
		assert.deepEqual(result, { ok: false, error: BACKEND_PROBE_ABORTED });
	});

	test("the caller's abort while the body is read reports an abort", async () => {
		const controller = new AbortController();
		const result = await with_fetch(
			async (_input, init) => {
				const signal = init?.signal;
				// headers arrive, then the body stalls until the signal aborts
				const response = new Response(
					new ReadableStream({
						start(stream) {
							signal?.addEventListener('abort', () => stream.error(signal.reason));
						}
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				);
				queueMicrotask(() => controller.abort());
				return response;
			},
			() => probe_backend({ signal: controller.signal, timeout_ms: 1_000 })
		);
		assert.deepEqual(result, { ok: false, error: BACKEND_PROBE_ABORTED });
	});

	test("the caller's abort reads as an abort, even with a TimeoutError reason", async () => {
		const controller = new AbortController();
		const result = await with_fetch(
			async (_input, init) => hanging_fetch(init),
			async () => {
				const pending = probe_backend({ signal: controller.signal, timeout_ms: 1_000 });
				controller.abort(new DOMException('deadline', 'TimeoutError'));
				return pending;
			}
		);
		assert.deepEqual(result, { ok: false, error: BACKEND_PROBE_ABORTED });
	});

	test("the caller's abort while the body is read reads as an abort, even with a TimeoutError reason", async () => {
		const controller = new AbortController();
		const result = await with_fetch(
			async (_input, init) => {
				const signal = init?.signal;
				const response = new Response(
					new ReadableStream({
						start(stream) {
							signal?.addEventListener('abort', () => stream.error(signal.reason));
						}
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				);
				queueMicrotask(() => controller.abort(new DOMException('deadline', 'TimeoutError')));
				return response;
			},
			() => probe_backend({ signal: controller.signal, timeout_ms: 1_000 })
		);
		assert.deepEqual(result, { ok: false, error: BACKEND_PROBE_ABORTED });
	});

	test('the default fetch with a signal still times out, naming the ms', async () => {
		const controller = new AbortController();
		const result = await with_fetch(
			async (_input, init) => hanging_fetch(init),
			() => probe_backend({ signal: controller.signal, timeout_ms: 20 })
		);
		assert.deepEqual(result, { ok: false, error: 'no reply within 20ms' });
	});

	test('an injected fetch owns its signal, so the option is unused', async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await probe_backend({
			fetch_health: () => Promise.reject(new TypeError('Failed to fetch')),
			signal: controller.signal
		});
		assert.deepEqual(result, { ok: false, error: 'Failed to fetch' });
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
	test('a signal is not an option, and a wider object never forwards one', async () => {
		const controller = new AbortController();
		controller.abort();
		assert.ok(
			// @ts-expect-error a signal on the reusable state would fail every later probe
			new BackendProbe({ fetch_health: json({ status: 'ok' }), signal: controller.signal })
		);
		const wide: BackendProbeOptions = { signal: controller.signal };
		const probe = new BackendProbe(wide);
		// the default fetch's signal is aborted only if the caller's was forwarded
		const reachable = await with_fetch(
			async (_input, init) =>
				init?.signal?.aborted ? Promise.reject(new Error('forwarded')) : json({ status: 'ok' })(),
			() => probe.probe()
		);
		assert.isTrue(reachable);
		assert.isNull(probe.error);
	});

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
