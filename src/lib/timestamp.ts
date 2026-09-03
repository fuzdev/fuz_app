/**
 * The canonical wire timestamp shape shared by the two spine implementations.
 *
 * Every timestamp that reaches the wire is second-precision UTC —
 * `YYYY-MM-DDTHH:MM:SSZ`, exactly 20 characters. Timestamps read from
 * Postgres get that shape from the SQL projection
 * (`iso8601_timestamp_column` in `db/sql_columns.ts`, twin of
 * `fuz_db::iso8601_timestamp_column`); this module is the same shape for the
 * stamps minted in TS rather than read back from a row, so the two sources
 * agree and the two backends serialize the same instant to the same bytes.
 *
 * @module
 */

/**
 * The canonical wire timestamp shape as a regex — second-precision UTC,
 * exactly 20 characters.
 *
 * Lives in library code rather than a test helper so the unit suites, the db
 * suites, and the cross-backend suites all pin the same pattern the server
 * renders.
 */
export const ISO8601_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * The width of one wire timestamp, in milliseconds.
 *
 * A wire stamp is truncated, not rounded, so the instant it names lies
 * anywhere in `[stamp, stamp + ISO8601_SECOND_MS)`. A predicate that must
 * not fire early against a stamp — "has this expiry passed?" — adds this to
 * reach the end of the second the stamp stands for.
 */
export const ISO8601_SECOND_MS = 1000;

/**
 * Whether the second a wire timestamp names has not yet ended.
 *
 * The one in-memory expiry rule over a truncated stamp: `stamp` stands for
 * `[stamp, stamp + ISO8601_SECOND_MS)`, so this admits until that whole
 * second is over and can never report an expiry the server's raw-column
 * `expires_at > NOW()` gate would still accept. A stamp that does not parse
 * is never live.
 *
 * @param stamp - a second-precision wire timestamp
 * @param now_ms - the current time in epoch milliseconds
 * @returns `true` while `now_ms` lies before the end of `stamp`'s second
 */
export const is_iso8601_seconds_live = (stamp: string, now_ms: number): boolean =>
	Date.parse(stamp) + ISO8601_SECOND_MS > now_ms;

/**
 * Render a `Date` as the canonical second-precision UTC wire timestamp
 * (`YYYY-MM-DDTHH:MM:SSZ`).
 *
 * Truncates rather than rounds, mirroring Postgres'
 * `to_char(…, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')` and the Rust spine's
 * `fuz_sys::rfc3339_now`.
 *
 * @param date - the instant to render
 * @returns the 20-character UTC timestamp
 */
export const to_iso8601_seconds = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;
