/**
 * Tests for timestamp.ts — the canonical wire timestamp shape.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';

import {
	ISO8601_SECONDS,
	ISO8601_SECOND_MS,
	is_iso8601_seconds_live,
	to_iso8601_seconds
} from '$lib/timestamp.ts';
import { iso8601_timestamp_column } from '$lib/db/sql_columns.ts';

describe('is_iso8601_seconds_live', () => {
	// the second-truncated wire stamp the predicate compares against
	const STAMP = '2026-06-01T12:00:00Z';
	const W = Date.parse(STAMP);

	test('is live through the end of the second the stamp names', () => {
		// the stamp stands for `[W, W + 1s)`, so the whole second is still live
		assert.strictEqual(is_iso8601_seconds_live(STAMP, W - 1), true);
		assert.strictEqual(is_iso8601_seconds_live(STAMP, W), true);
		assert.strictEqual(is_iso8601_seconds_live(STAMP, W + ISO8601_SECOND_MS - 1), true);
	});

	test('is over once that second has ended', () => {
		assert.strictEqual(is_iso8601_seconds_live(STAMP, W + ISO8601_SECOND_MS), false);
		assert.strictEqual(is_iso8601_seconds_live(STAMP, W + ISO8601_SECOND_MS * 60), false);
	});

	test('never treats a malformed stamp as live', () => {
		assert.strictEqual(is_iso8601_seconds_live('not-a-timestamp', W), false);
		assert.strictEqual(is_iso8601_seconds_live('12:00:00', W), false);
	});
});

describe('to_iso8601_seconds', () => {
	test('renders second-precision UTC', () => {
		assert.strictEqual(
			to_iso8601_seconds(new Date(Date.UTC(2026, 8, 3, 12, 34, 56))),
			'2026-09-03T12:34:56Z'
		);
	});

	test('truncates sub-second precision rather than rounding', () => {
		assert.strictEqual(
			to_iso8601_seconds(new Date(Date.UTC(2026, 8, 3, 12, 34, 56, 999))),
			'2026-09-03T12:34:56Z'
		);
	});

	test('renders exactly the shape `ISO8601_SECONDS` matches', () => {
		assert.match(to_iso8601_seconds(new Date()), ISO8601_SECONDS);
		assert.strictEqual(to_iso8601_seconds(new Date()).length, 20);
	});
});

describe('ISO8601_SECONDS', () => {
	test('refuses the millisecond and offset forms', () => {
		// `Date.prototype.toISOString` is the shape this converged away from.
		assert.notMatch(new Date().toISOString(), ISO8601_SECONDS);
		assert.notMatch('2026-09-03T12:34:56+00:00', ISO8601_SECONDS);
		assert.notMatch('2026-09-03 12:34:56Z', ISO8601_SECONDS);
	});

	test('is the shape the SQL projection renders', () => {
		// The Postgres format literal spells the same layout the regex pins:
		// four-digit year, `T` separator, `Z` suffix, no fractional seconds.
		assert.strictEqual(
			iso8601_timestamp_column('', 'created_at'),
			`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`
		);
	});
});
