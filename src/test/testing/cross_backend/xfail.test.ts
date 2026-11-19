/**
 * Tests for `xfail_until`'s body, `run_xfail`: the tracked failure passes,
 * any other failure is red, a throwing matcher is red, and a body that passes
 * is red (the gap closed).
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import { run_xfail, xfail_matches, type XfailMarker } from '#lib/testing/cross_backend/xfail.ts';

const marker = (fails_with: XfailMarker['fails_with']): XfailMarker => ({
	tracking_id: 'tracked-gap',
	reason: 'deferred',
	fails_with
});

const throws = (message: string) => (): void => {
	throw new Error(message);
};

describe('run_xfail', () => {
	test('a failure the regex matches passes', async () => {
		await run_xfail(marker(/expected 403/), throws('expected 403, got 200'));
	});

	test('a rejection the predicate accepts passes', async () => {
		await run_xfail(
			marker((error) => error instanceof TypeError),
			() => Promise.reject(new TypeError('nope'))
		);
	});

	test('a failure the matcher rejects is red, naming the tracking id, with the cause', async () => {
		const original = new Error('method not found: typo_method');
		const error = await assert_rejects(
			() =>
				run_xfail(marker(/expected 403/), () => {
					throw original;
				}),
			/xfail_until tracked-gap: failed, but not with the tracked failure/
		);
		assert.include(error.message, 'method not found: typo_method');
		assert.strictEqual(error.cause, original);
	});

	test('a matcher that throws is red, naming the tracking id and the failure, with its cause', async () => {
		const matcher_error = new TypeError('matcher broke');
		const error = await assert_rejects(
			() =>
				run_xfail(
					marker(() => {
						throw matcher_error;
					}),
					throws('expected 403, got 200')
				),
			/xfail_until tracked-gap: the fails_with matcher threw/
		);
		assert.include(error.message, 'expected 403, got 200');
		assert.include(error.message, 'matcher broke');
		assert.strictEqual(error.cause, matcher_error);
	});

	test('a regex reads the whole failure text `assert.fail` throws', async () => {
		// a long failure, its distinguishing part at the end: `assert.strictEqual`
		// would print the value truncated, `assert.fail` throws it whole
		const failure = `[case] params ${'x'.repeat(200)} → 200 {"result":{"ok":true}}`;
		await run_xfail(marker(/→ 200 \{"result"/), () => {
			assert.fail(failure);
		});
		await assert_rejects(
			() =>
				run_xfail(marker(/→ 200 \{"result"/), () => {
					assert.strictEqual(failure, null);
				}),
			/not with the tracked failure/
		);
	});

	test('a body that passes is red: the gap closed', async () => {
		await assert_rejects(
			() => run_xfail(marker(/expected 403/), () => undefined),
			/xfail_until tracked-gap: gap closed — the body passed; remove the marker/
		);
	});
});

describe('xfail_matches', () => {
	test('a regex reads a non-Error throw through String', () => {
		assert.ok(xfail_matches(/boom/, 'boom'));
		assert.ok(!xfail_matches(/boom/, 'bang'));
	});

	test('a global regex gives the same answer on every call', () => {
		const matcher = /boom/g;
		const error = new Error('boom');
		assert.ok(xfail_matches(matcher, error));
		assert.ok(xfail_matches(matcher, error));
	});
});
