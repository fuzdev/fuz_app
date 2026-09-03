import '../assert_dev_env.ts';

/**
 * Wire-shape assertions shared by the cross-backend suites.
 *
 * A field can carry the right value on both backends and still be a parity
 * defect if the two serialize it differently — a millisecond
 * `2026-05-17T12:34:56.789Z` and a second-precision `2026-05-17T12:34:56Z`
 * both parse as the same instant, so a Zod `z.string()` check and an
 * `assert.ok(value)` pass on either. These helpers pin the bytes.
 *
 * @module
 */

import { assert } from 'vitest';

import { ISO8601_SECONDS } from '../../timestamp.ts';

/**
 * Assert `value` is a timestamp in the spine's canonical wire shape:
 * second-precision UTC, exactly 20 characters. The TS spine emits it from
 * the `iso8601_timestamp_column` SQL projection (`db/sql_columns.ts`) and
 * `to_iso8601_seconds` (`timestamp.ts`); the Rust spine from
 * `fuz_db::iso8601_timestamp_column` and `fuz_sys::rfc3339_now`.
 *
 * @param value - the field read off a wire response
 * @param label - the field's name, for the failure message
 */
export const assert_iso8601_seconds = (value: unknown, label: string): void => {
	assert.isTrue(
		typeof value === 'string',
		`${label} must be a string, got ${JSON.stringify(value)}`
	);
	assert.match(value as string, ISO8601_SECONDS, `${label} must be second-precision UTC`);
};

/**
 * Assert `value` is either `null` or a canonical second-precision UTC
 * timestamp — the shape of every nullable timestamp on the wire
 * (`expires_at`, `deleted_at`, `updated_at`, …).
 *
 * @param value - the field read off a wire response
 * @param label - the field's name, for the failure message
 */
export const assert_iso8601_seconds_nullable = (value: unknown, label: string): void => {
	if (value === null) return;
	assert_iso8601_seconds(value, label);
};
