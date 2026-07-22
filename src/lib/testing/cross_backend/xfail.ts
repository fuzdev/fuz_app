import '../assert_dev_env.ts';

/**
 * `xfail_until` — mark a deferred-by-design gap as an expected failure.
 *
 * A thin wrapper over vitest's `test.fails` that bakes a tracking id +
 * reason into the test label. Two properties make it the right tool for
 * declared gaps (distinct from in-scope gaps, which fail loud as a normal
 * red `test`):
 *
 * - **Visible** — the case shows in the report as a distinct expected
 *   failure, not a silent `.skip`, so a deferred gap never disappears from
 *   view.
 * - **Self-cleaning** — `test.fails` turns **red** the moment the body
 *   stops throwing (i.e. the impl starts passing), forcing whoever closed
 *   the gap to delete the marker. A `.skip` would rot silently; this can't.
 *
 * Sibling to `test_if` in `testing/cross_backend/capabilities.ts`. No taxonomy — a one-line
 * marker with a tracking id and a reason, nothing more.
 *
 * @module
 */

import { test } from 'vitest';

/**
 * Register `fn` as an expected-failure test. Passes while `fn` throws /
 * rejects; **fails** once `fn` succeeds (signalling the gap closed and the
 * marker should be removed).
 *
 * @param tracking_id - descriptive id of the tracked gap (e.g.
 *   `'audit-log-sse-rust-spine'`) — a feature/behavior name, not a
 *   process/milestone label.
 * @param reason - why the case is deferred-by-design.
 * @param name - the assertion / test label.
 * @param fn - the test body (expected to throw/reject until the gap closes).
 */
export const xfail_until = (
	tracking_id: string,
	reason: string,
	name: string,
	fn: () => void | Promise<void>
): void => {
	test.fails(`${name} [xfail_until ${tracking_id}: ${reason}]`, fn);
};
