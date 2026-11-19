import '../assert_dev_env.ts';

/**
 * `xfail_until` — mark a deferred-by-design gap as an expected failure.
 *
 * Registers a plain `test` that runs the body and requires it to fail the
 * tracked way. Three properties make it the right tool for declared gaps
 * (distinct from in-scope gaps, which fail loud as a normal red `test`):
 *
 * - **Visible** — the case shows in the report with its tracking id and
 *   reason in the label, not as a silent `.skip`, so a deferred gap never
 *   disappears from view.
 * - **Specific** — the failure must be the tracked one (`XfailMarker.fails_with`).
 *   Any other throw — a typo'd method, a fixture error, an unrelated
 *   regression — is red, so the marker can't hide a failure it doesn't name.
 * - **Self-cleaning** — the test turns **red** the moment the body stops
 *   throwing (the impl starts passing), forcing whoever closed the gap to
 *   delete the marker. A `.skip` would rot silently; this can't.
 *
 * Sibling to `test_if` in `testing/cross_backend/capabilities.ts`. No taxonomy — a
 * tracking id, a reason, and the failure expected, nothing more.
 *
 * @module
 */

import { test } from 'vitest';

/**
 * What the tracked failure looks like: a `RegExp` tested against the thrown
 * error's message (`String(error)` for a non-`Error`), or a predicate over
 * the thrown value.
 */
export type XfailMatcher = RegExp | ((error: unknown) => boolean);

/** A tracked gap: its id, why it is deferred, and the failure it shows. */
export interface XfailMarker {
	/**
	 * Descriptive id of the tracked gap (e.g. `'audit-log-sse-rust-spine'`) —
	 * a feature/behavior name, not a process/milestone label.
	 */
	readonly tracking_id: string;
	/** Why the case is deferred-by-design. */
	readonly reason: string;
	/** The failure the gap shows; any other failure is red. */
	readonly fails_with: XfailMatcher;
}

/**
 * Whether `error` is the failure `matcher` describes.
 *
 * @param matcher - the marker's `fails_with`
 * @param error - the value the body threw
 */
export const xfail_matches = (matcher: XfailMatcher, error: unknown): boolean => {
	if (typeof matcher === 'function') return matcher(error);
	const message = error instanceof Error ? error.message : String(error);
	matcher.lastIndex = 0; // a `g` or `y` flag would otherwise carry state across calls
	return matcher.test(message);
};

/**
 * Run `fn` as an expected failure: resolves when it throws the tracked
 * failure, throws when it throws anything else (wrapping the original as
 * `cause`) or when it succeeds (the gap closed).
 *
 * @param marker - the tracked gap
 * @param fn - the body, expected to throw the tracked failure until the gap closes
 * @throws Error naming `marker.tracking_id` when `fn` succeeds or fails another way,
 *   or when the matcher throws (the matcher's error as `cause`)
 */
export const run_xfail = async (
	marker: XfailMarker,
	fn: () => void | Promise<void>
): Promise<void> => {
	try {
		await fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		let matched: boolean;
		try {
			matched = xfail_matches(marker.fails_with, error);
		} catch (matcher_error) {
			// a throwing matcher would otherwise surface alone, with no tracking id
			// and the body's failure lost
			throw new Error(
				`xfail_until ${marker.tracking_id}: the fails_with matcher threw on the body's ` +
					`failure (${message}): ${
						matcher_error instanceof Error ? matcher_error.message : String(matcher_error)
					}`,
				{ cause: matcher_error }
			);
		}
		if (matched) return;
		throw new Error(
			`xfail_until ${marker.tracking_id}: failed, but not with the tracked failure ` +
				`(${String(marker.fails_with)}): ${message}`,
			{ cause: error }
		);
	}
	throw new Error(
		`xfail_until ${marker.tracking_id}: gap closed — the body passed; remove the marker`
	);
};

/**
 * Register `fn` as an expected-failure test. Passes while `fn` throws the
 * tracked failure; **fails** on any other failure, and once `fn` succeeds
 * (signalling the gap closed and the marker should be removed).
 *
 * @param marker - the tracked gap, with the failure it must show
 * @param name - the assertion / test label
 * @param fn - the test body (expected to throw the tracked failure until the gap closes)
 */
export const xfail_until = (
	marker: XfailMarker,
	name: string,
	fn: () => void | Promise<void>
): void => {
	test(`${name} [xfail_until ${marker.tracking_id}: ${marker.reason}]`, () =>
		run_xfail(marker, fn));
};
