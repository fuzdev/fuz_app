/**
 * Tests for `create_test_app`'s audit drift check — an app built in a test
 * fails that test when the process-wide audit counters
 * (`assert_no_audit_drift`) moved during it, with no
 * `install_audit_drift_guard` in the suite, unless the test reset the
 * counter it moved on purpose, and a retried test starts from zero counts.
 *
 * @module
 */

import { assert, test } from 'vitest';

import {
	get_audit_success_outside_transaction,
	reset_audit_success_outside_transaction
} from '#lib/auth/audit_emitter.ts';
import { create_test_app } from '#lib/testing/test_app.ts';

const session_cookie_name = 'test_session';

// a success row on the pool counts as written outside a transaction
test.fails('a success row written on the pool fails the test that built the app', async () => {
	const test_app = await create_test_app({ session_cookie_name, create_route_specs: () => [] });
	await test_app.backend.deps.audit.emit_pool({ event_type: 'login', outcome: 'success' });
	assert.strictEqual(get_audit_success_outside_transaction(), 1);
});

// runs after the failing test above, whose count was never reset: the count
// here starting from zero shows the reset at the test's first app
test('a test that resets the counter it moved on purpose passes', async () => {
	const test_app = await create_test_app({ session_cookie_name, create_route_specs: () => [] });
	await test_app.backend.deps.audit.emit_pool({ event_type: 'login', outcome: 'success' });
	assert.strictEqual(get_audit_success_outside_transaction(), 1);
	reset_audit_success_outside_transaction();
});

// vitest reuses the task on a retry: the retry resets the counters afresh,
// rather than inheriting what the failed attempt left
let attempt = 0;
test('a retried test starts from zero counts', { retry: 1 }, async () => {
	attempt++;
	const test_app = await create_test_app({ session_cookie_name, create_route_specs: () => [] });
	if (attempt === 1) {
		await test_app.backend.deps.audit.emit_pool({ event_type: 'login', outcome: 'success' });
		throw new Error('the first attempt fails, its count left behind');
	}
	assert.strictEqual(get_audit_success_outside_transaction(), 0);
});
