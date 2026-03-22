/**
 * Formatting utilities for UI display.
 *
 * Value formatting, relative timestamps, uptime display,
 * absolute timestamp formatting, and audit metadata formatting.
 *
 * @module
 */

import type {AuditEventType} from '../auth/audit_log_schema.js';

/**
 * Format a timestamp as a relative time string.
 *
 * @param timestamp - a date value (`string`, `number`, or `Date`)
 * @param now - reference time in ms since epoch, defaults to `Date.now()`
 * @returns human-friendly relative time (e.g. "2m ago", "3h ago", "5d ago", "2mo ago", "1y ago")
 */
export const format_relative_time = (
	timestamp: string | number | Date,
	now: number = Date.now(),
): string => {
	const ts =
		typeof timestamp === 'number'
			? timestamp
			: timestamp instanceof Date
				? timestamp.getTime()
				: new Date(timestamp).getTime();
	const diff_ms = now - ts;
	if (Number.isNaN(diff_ms)) return 'just now';
	const abs_ms = Math.abs(diff_ms);
	const past = diff_ms >= 0;
	const abs_mins = Math.floor(abs_ms / 60000);
	const abs_hours = Math.floor(abs_ms / 3600000);
	const abs_days = Math.floor(abs_ms / 86400000);
	const abs_weeks = Math.floor(abs_days / 7);
	const abs_months = Math.floor(abs_days / 30);
	const abs_years = Math.floor(abs_days / 365);

	if (abs_mins <= 0) return 'just now';
	const suffix = past ? ' ago' : '';
	const prefix = past ? '' : 'in ';
	if (abs_mins < 60) return `${prefix}${abs_mins}m${suffix}`;
	if (abs_hours < 24) return `${prefix}${abs_hours}h${suffix}`;
	if (abs_days < 7) return `${prefix}${abs_days}d${suffix}`;
	if (abs_weeks < 5) return `${prefix}${abs_weeks}w${suffix}`;
	if (abs_months < 12) return `${prefix}${abs_months}mo${suffix}`;
	return `${prefix}${abs_years}y${suffix}`;
};

/**
 * Format milliseconds as a human-friendly uptime string.
 *
 * @param ms - duration in milliseconds
 * @returns human-friendly duration (e.g. "45s", "12m", "3h 15m", "2d 5h")
 */
export const format_uptime = (ms: number): string => {
	if (ms < 0) return `-${format_uptime(-ms)}`;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remaining_mins = minutes % 60;
	if (hours < 24) return remaining_mins > 0 ? `${hours}h ${remaining_mins}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	const remaining_hours = hours % 24;
	return remaining_hours > 0 ? `${days}d ${remaining_hours}h` : `${days}d`;
};

/**
 * Truncate a string by keeping the start and end, with a separator in the middle.
 *
 * @param str - the string to truncate
 * @param max_length - maximum total length including separator
 * @param separator - the middle separator
 * @returns the truncated string, or the original if it fits
 */
export const truncate_middle = (str: string, max_length: number, separator = '…'): string => {
	if (str.length <= max_length) return str;
	const available = max_length - separator.length;
	if (available <= 0) return separator.slice(0, max_length);
	const start_length = Math.ceil(available / 2);
	const end_length = Math.floor(available / 2);
	return str.slice(0, start_length) + separator + str.slice(str.length - end_length);
};

/**
 * Truncate a UUID for display, keeping start and end visible.
 *
 * @param uuid - the UUID string to truncate
 * @returns a 12-character truncated UUID like `a1b2c…7890`
 */
export const truncate_uuid = (uuid: string): string => truncate_middle(uuid, 12);

/**
 * Format an arbitrary value for table cell display.
 *
 * @param value - the value to format
 * @returns string representation suitable for UI display
 */
export const format_value = (value: unknown): string => {
	if (value === null) return 'NULL';
	if (value === undefined) return 'undefined';
	if (typeof value === 'object') return JSON.stringify(value);
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
		return String(value);
	if (typeof value === 'symbol') return value.toString();
	return String(value as (...args: Array<unknown>) => unknown);
};

/**
 * Format a timestamp as an absolute datetime string for title attributes.
 *
 * @param timestamp - a date value
 * @returns readable absolute datetime like `"2026-03-21 14:30:00 UTC"`
 */
export const format_datetime_local = (timestamp: string | number | Date): string => {
	const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
	if (Number.isNaN(date.getTime())) return '';
	return date
		.toISOString()
		.replace('T', ' ')
		.replace(/\.\d+Z$/, ' UTC');
};

/**
 * Format audit event metadata for display based on event type.
 *
 * @param event_type - the audit event type
 * @param metadata - the metadata object (may be null)
 * @returns human-readable summary string
 */
export const format_audit_metadata = (
	event_type: AuditEventType,
	metadata: Record<string, unknown> | null,
): string => {
	if (!metadata) return '';
	switch (event_type) {
		case 'login':
			return metadata.username ? `user: ${metadata.username as string}` : '';
		case 'logout':
			return '';
		case 'bootstrap':
			return metadata.error ? `error: ${metadata.error as string}` : '';
		case 'signup':
			return [
				metadata.username ? `user: ${metadata.username as string}` : '',
				metadata.invite_id ? 'via invite' : '',
				metadata.open_signup ? 'open signup' : '',
			]
				.filter(Boolean)
				.join(', ');
		case 'password_change':
			return metadata.sessions_revoked != null
				? `${metadata.sessions_revoked as number} sessions revoked`
				: '';
		case 'session_revoke':
			return metadata.session_id
				? `session: ${truncate_middle(metadata.session_id as string, 12)}`
				: '';
		case 'session_revoke_all':
			return metadata.count != null ? `${metadata.count as number} sessions` : '';
		case 'token_create':
			return metadata.name ? `"${metadata.name as string}"` : '';
		case 'token_revoke':
			return metadata.token_id ? `token: ${truncate_middle(metadata.token_id as string, 12)}` : '';
		case 'token_revoke_all':
			return metadata.count != null ? `${metadata.count as number} tokens` : '';
		case 'permit_grant':
			return metadata.role ? `role: ${metadata.role as string}` : '';
		case 'permit_revoke':
			return metadata.role ? `role: ${metadata.role as string}` : '';
		case 'invite_create':
			return [
				metadata.email ? `email: ${metadata.email as string}` : '',
				metadata.username ? `user: ${metadata.username as string}` : '',
			]
				.filter(Boolean)
				.join(', ');
		case 'invite_delete':
			return metadata.invite_id
				? `invite: ${truncate_middle(metadata.invite_id as string, 12)}`
				: '';
		case 'app_settings_update':
			return metadata.setting
				? `${metadata.setting as string}: ${JSON.stringify(metadata.old_value)} → ${JSON.stringify(metadata.new_value)}`
				: '';
		default:
			return JSON.stringify(metadata);
	}
};
