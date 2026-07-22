import { assert, describe, test } from 'vitest';

import {
	FINGERPRINT_HEADERS,
	assert_expected_headers,
	assert_no_fingerprint_headers
} from '$lib/testing/cross_backend/conformance_table.ts';
import { headers_to_record } from '$lib/testing/rpc_helpers.ts';

/**
 * Pure-function coverage of the conformance runner's header invariants — the
 * no-fingerprint floor and the `expect.headers` axis — so both branches are
 * pinned deterministically without spawning a backend (the dispatch-pipeline
 * proof is the in-process + cross-process `conformance.{db,cross}.test.ts`
 * legs).
 */

describe('headers_to_record', () => {
	test('lowercases keys and snapshots values', () => {
		const headers = new Headers({ 'Content-Type': 'application/json', 'X-Custom': 'v' });
		const record = headers_to_record(headers);
		assert.strictEqual(record['content-type'], 'application/json');
		assert.strictEqual(record['x-custom'], 'v');
	});

	test('empty headers produce an empty record', () => {
		assert.deepStrictEqual(headers_to_record(new Headers()), {});
	});
});

describe('assert_no_fingerprint_headers', () => {
	test('passes on a clean response', () => {
		assert_no_fingerprint_headers({ 'content-type': 'application/json' }, 'clean');
	});

	test('passes on an empty header set', () => {
		assert_no_fingerprint_headers({}, 'empty');
	});

	for (const name of FINGERPRINT_HEADERS) {
		test(`throws when '${name}' is present`, () => {
			assert.throws(() => {
				assert_no_fingerprint_headers({ [name]: 'leaked' }, `leak-${name}`);
			}, new RegExp(name));
		});
	}
});

describe('assert_expected_headers', () => {
	test('passes when a present header equals the expected value', () => {
		assert_expected_headers(
			{ 'content-type': 'application/json' },
			{ 'content-type': 'application/json' },
			'present-equal'
		);
	});

	test('matches the header name case-insensitively', () => {
		assert_expected_headers({ 'x-custom': 'v' }, { 'X-Custom': 'v' }, 'case-insensitive');
	});

	test('throws when a present header value differs', () => {
		assert.throws(() => {
			assert_expected_headers(
				{ 'content-type': 'text/plain' },
				{ 'content-type': 'application/json' },
				'value-mismatch'
			);
		});
	});

	test('throws when an expected-present header is absent', () => {
		assert.throws(() => {
			assert_expected_headers({}, { 'content-type': 'application/json' }, 'missing');
		});
	});

	test('passes when a null-expected header is absent', () => {
		assert_expected_headers({ 'content-type': 'application/json' }, { server: null }, 'absent-ok');
	});

	test('throws when a null-expected header is present', () => {
		assert.throws(() => {
			assert_expected_headers({ server: 'nginx' }, { server: null }, 'absent-violated');
		});
	});
});
