/**
 * Shared async test utilities for `async_slot.test.ts` and
 * `keyed_async_slot.test.ts`. Both suites need the same deferred-promise
 * factory and the same "reject when the signal fires" helper for testing
 * supersession / abort semantics. Extracting them keeps the per-suite
 * files focused on the behaviors that actually differ.
 *
 * Not itself a test file — no `.test.` infix means vitest does not pick
 * it up. Mirrors the pattern in ../auth/notification_helpers.ts and
 * the other `_test_helpers.ts` siblings.
 *
 * @module
 */

/** Promise + resolve/reject handles, for tests that need to control when a slot's run() completes. */
export const make_deferred = <T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: Error) => void;
} => {
	let resolve_fn!: (value: T) => void;
	let reject_fn!: (reason: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve_fn = res;
		reject_fn = rej;
	});
	return { promise, resolve: resolve_fn, reject: reject_fn };
};

/**
 * Promise that rejects when `signal` aborts. Use as the slot callback
 * body to exercise the abort path without resolving the underlying work.
 */
export const signal_rejection = <T>(signal: AbortSignal): Promise<T> =>
	new Promise<T>((_, reject) => {
		signal.addEventListener(
			'abort',
			() => {
				const reason: unknown = signal.reason;
				reject(reason instanceof Error ? reason : new Error(String(reason)));
			},
			{ once: true }
		);
	});
