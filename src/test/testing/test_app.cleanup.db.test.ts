/**
 * Tests for how a test app closes — `TestApp.cleanup` fails the test that
 * called it on a close that gave up on work still in flight, within the test
 * drain bound, while the server's own `close` still resolves the report for a
 * test that gives up on purpose; an app built in a test is closed when that
 * test finishes, failing it on a give-up unless it already failed; one built
 * in `beforeAll` is left to its suite, and one built in a concurrent test is
 * refused.
 *
 * @module
 */

import { afterAll, assert, beforeAll, describe, test } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import type { AcceptedRequest } from '#lib/http/pending_effects.ts';
import { create_test_request_headers } from '#lib/testing/test_origin.ts';
import {
	create_test_app,
	TEST_SHUTDOWN_DRAIN_TIMEOUT_MS,
	type TestApp
} from '#lib/testing/test_app.ts';
import { expect_logged_error } from '#lib/testing/logged_errors.ts';

const session_cookie_name = 'test_session';

/**
 * How far past the drain bound a give-up may land: the close's own steps
 * around the bounded wait.
 */
const CLOSE_SLACK_MS = 1000;

test('cleanup rejects on a give-up, naming the report, within the test drain bound', async () => {
	expect_logged_error('create_app_server: shutdown gave up after');
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
	expect_logged_error('create_app_server: shutdown gave up after');
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

// The close when a test finishes: each case below records what its app's
// finish did, and the case after it reads the record.

/** A path no route serves: 404 while the server is open, 503 once it closes. */
const PROBE_PATH = '/api/probe';

/** The errors the close when the test finished left on the leaking test. */
let finish_errors: Array<string> | null = null;
/** An app built in a test, read once that test has finished. */
let finished_app: TestApp | null = null;

test.fails(
	'an app built in a test and left with work in flight fails the test when it finishes',
	async ({ onTestFinished }) => {
		let leaked: AcceptedRequest | null = null;
		// registered ahead of the app's own hook, so it runs after it
		onTestFinished(({ task }) => {
			finish_errors = (task.result?.errors ?? []).map((e) => e.message);
			leaked?.finish(null);
		});
		const test_app = await create_test_app({ session_cookie_name, create_route_specs: () => [] });
		leaked = test_app.backend.deps.request_tracker.accept();
		assert.ok(leaked);
	}
);

test('the failure names the give-up report', () => {
	assert.ok(finish_errors, 'the leaking test finished');
	assert.strictEqual(finish_errors.length, 1, finish_errors.join('\n'));
	assert.include(finish_errors[0], 'the close when the test finished gave up');
	assert.include(finish_errors[0], '"requests":1');
});

/** The errors left on a failing test whose app also gave up. */
let failed_errors: Array<string> | null = null;

test.fails(
	'a test that already failed is left as it failed, whatever its app left in flight',
	async ({ onTestFinished }) => {
		let leaked: AcceptedRequest | null = null;
		// registered ahead of the app's own hook, so it runs after it
		onTestFinished(({ task }) => {
			failed_errors = (task.result?.errors ?? []).map((e) => e.message);
			leaked?.finish(null);
		});
		const test_app = await create_test_app({ session_cookie_name, create_route_specs: () => [] });
		leaked = test_app.backend.deps.request_tracker.accept();
		assert.ok(leaked);
		assert.fail('the test fails on its own');
	}
);

test('the failed test carries only its own error', () => {
	assert.deepStrictEqual(failed_errors, ['the test fails on its own']);
});

test('an app built in a test is left open by its body', async () => {
	finished_app = await create_test_app({ session_cookie_name, create_route_specs: () => [] });
});

test('and closed once that test finishes', async () => {
	assert.ok(finished_app);
	const res = await finished_app.app.request(PROBE_PATH, {
		headers: create_test_request_headers()
	});
	assert.strictEqual(res.status, 503, 'refused: the server is draining or closed');
});

describe('an app built in beforeAll', () => {
	let test_app: TestApp | null = null;
	beforeAll(async () => {
		test_app = await create_test_app({ session_cookie_name, create_route_specs: () => [] });
	});
	afterAll(async () => {
		await test_app?.cleanup();
	});

	test('outlives each test', () => {
		assert.ok(test_app);
	});

	test('so the next test still reaches it', async () => {
		assert.ok(test_app);
		const res = await test_app.app.request(PROBE_PATH, { headers: create_test_request_headers() });
		assert.strictEqual(res.status, 404, 'routed: the server is open');
	});
});

// vitest names whichever concurrent test started last current, so the close
// at a concurrent test's finish could land on a sibling's app
describe.concurrent('inside a concurrent test', () => {
	test('create_test_app throws, naming beforeAll', async () => {
		const error = await assert_rejects(() =>
			create_test_app({ session_cookie_name, create_route_specs: () => [] })
		);
		assert.include(error.message, 'concurrent test');
		assert.include(error.message, '`beforeAll`');
	});
});
