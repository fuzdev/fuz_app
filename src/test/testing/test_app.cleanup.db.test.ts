/**
 * Tests for `TestApp.cleanup` — a close that gave up on work still in flight
 * fails the test that called it, within the test drain bound, while the
 * server's own `close` still resolves the report for a test that gives up on
 * purpose.
 *
 * @module
 */

import { test, assert } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import { create_test_app, TEST_SHUTDOWN_DRAIN_TIMEOUT_MS } from '#lib/testing/test_app.ts';

const session_cookie_name = 'test_session';

/**
 * How far past the drain bound a give-up may land: the close's own steps
 * around the bounded wait.
 */
const CLOSE_SLACK_MS = 1000;

test('cleanup rejects on a give-up, naming the report, within the test drain bound', async () => {
	const test_app = await create_test_app({ session_cookie_name, create_route_specs: () => [] });
	// a request held and never finished — the work the drain gives up on
	const leaked = test_app.backend.deps.request_tracker.accept();
	assert.ok(leaked);
	const started = performance.now();
	try {
		const error = await assert_rejects(() => test_app.cleanup());
		const elapsed = performance.now() - started;
		assert.include(error.message, 'gave up');
		assert.include(error.message, '"requests":1');
		assert.isAtLeast(elapsed, TEST_SHUTDOWN_DRAIN_TIMEOUT_MS - 50);
		assert.isBelow(elapsed, TEST_SHUTDOWN_DRAIN_TIMEOUT_MS + CLOSE_SLACK_MS);
	} finally {
		leaked.finish(null);
	}
});

test('cleanup resolves once the close drained everything', async () => {
	const test_app = await create_test_app({ session_cookie_name, create_route_specs: () => [] });
	const resolved = await test_app.cleanup().then((value: unknown) => value);
	assert.isUndefined(resolved);
});

test('server.close resolves the give-up report, on the bound app_options sets', async () => {
	const shutdown_drain_timeout_ms = 50;
	const test_app = await create_test_app({
		session_cookie_name,
		create_route_specs: () => [],
		app_options: { shutdown_drain_timeout_ms }
	});
	const leaked = test_app.backend.deps.request_tracker.accept();
	assert.ok(leaked);
	const started = performance.now();
	try {
		const given_up = await test_app.server.close();
		assert.isBelow(performance.now() - started, TEST_SHUTDOWN_DRAIN_TIMEOUT_MS);
		assert.deepStrictEqual(given_up, { requests: 1, audit_writes: 0, upkeep: 0 });
	} finally {
		leaked.finish(null);
	}
});
