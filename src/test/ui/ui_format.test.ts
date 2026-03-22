/**
 * Tests for ui_format - time and value formatting utilities.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';

import {
	format_relative_time,
	format_uptime,
	format_value,
	format_datetime_local,
	format_audit_metadata,
	truncate_middle,
	truncate_uuid,
} from '$lib/ui/ui_format.js';

const t = (iso: string): number => new Date(iso).getTime();

describe('format_relative_time', () => {
	test('returns "just now" for timestamps less than a minute ago', () => {
		const now = Date.now();
		assert.strictEqual(format_relative_time(new Date(now).toISOString(), now), 'just now');
	});

	test('returns minutes ago', () => {
		assert.strictEqual(
			format_relative_time('2026-01-15T12:00:00Z', t('2026-01-15T12:05:00Z')),
			'5m ago',
		);
	});

	test('returns hours ago', () => {
		assert.strictEqual(
			format_relative_time('2026-01-15T12:00:00Z', t('2026-01-15T15:00:00Z')),
			'3h ago',
		);
	});

	test('returns days ago', () => {
		assert.strictEqual(
			format_relative_time('2026-01-15T12:00:00Z', t('2026-01-18T12:00:00Z')),
			'3d ago',
		);
	});

	test('returns weeks ago for 7-34 days', () => {
		assert.strictEqual(
			format_relative_time('2026-01-15T12:00:00Z', t('2026-01-22T12:00:00Z')),
			'1w ago',
		);
		assert.strictEqual(
			format_relative_time('2026-01-15T12:00:00Z', t('2026-02-01T12:00:00Z')),
			'2w ago',
		);
		assert.strictEqual(
			format_relative_time('2026-01-15T12:00:00Z', t('2026-02-15T12:00:00Z')),
			'4w ago',
		);
	});

	test('returns months ago for 5 weeks to 12 months', () => {
		assert.strictEqual(
			format_relative_time('2026-01-15T12:00:00Z', t('2026-03-15T12:00:00Z')),
			'1mo ago',
		);
		assert.strictEqual(
			format_relative_time('2026-01-15T12:00:00Z', t('2026-07-15T12:00:00Z')),
			'6mo ago',
		);
		assert.strictEqual(
			format_relative_time('2026-01-15T12:00:00Z', t('2026-12-01T12:00:00Z')),
			'10mo ago',
		);
	});

	test('returns years ago for 12 months or more', () => {
		assert.strictEqual(
			format_relative_time('2026-01-15T12:00:00Z', t('2027-01-20T12:00:00Z')),
			'1y ago',
		);
		assert.strictEqual(
			format_relative_time('2026-01-15T12:00:00Z', t('2029-06-15T12:00:00Z')),
			'3y ago',
		);
	});

	test('returns "just now" for invalid date string', () => {
		assert.strictEqual(format_relative_time('garbage', Date.now()), 'just now');
	});

	test('returns "just now" for small clock skew (under 1 minute)', () => {
		assert.strictEqual(
			format_relative_time('2026-01-15T12:00:30Z', t('2026-01-15T12:00:00Z')),
			'just now',
		);
	});

	test('returns future relative time for timestamps ahead', () => {
		assert.strictEqual(
			format_relative_time('2026-01-15T12:05:00Z', t('2026-01-15T12:00:00Z')),
			'in 5m',
		);
	});

	test('returns future hours', () => {
		assert.strictEqual(
			format_relative_time('2026-01-15T15:00:00Z', t('2026-01-15T12:00:00Z')),
			'in 3h',
		);
	});

	test('returns future days', () => {
		assert.strictEqual(
			format_relative_time('2026-01-18T12:00:00Z', t('2026-01-15T12:00:00Z')),
			'in 3d',
		);
	});

	test('returns future weeks', () => {
		assert.strictEqual(
			format_relative_time('2026-01-29T12:00:00Z', t('2026-01-15T12:00:00Z')),
			'in 2w',
		);
	});

	test('returns future months', () => {
		assert.strictEqual(
			format_relative_time('2026-07-15T12:00:00Z', t('2026-01-15T12:00:00Z')),
			'in 6mo',
		);
	});

	test('returns "just now" at exactly 0 diff', () => {
		const now = t('2026-01-15T12:00:00Z');
		assert.strictEqual(format_relative_time('2026-01-15T12:00:00Z', now), 'just now');
	});

	test('returns "1m ago" at exactly 1 minute', () => {
		assert.strictEqual(
			format_relative_time('2026-01-15T12:00:00Z', t('2026-01-15T12:01:00Z')),
			'1m ago',
		);
	});

	test('accepts a number timestamp', () => {
		const now = t('2026-01-15T12:05:00Z');
		assert.strictEqual(format_relative_time(t('2026-01-15T12:00:00Z'), now), '5m ago');
	});

	test('accepts a Date timestamp', () => {
		const now = t('2026-01-15T12:05:00Z');
		assert.strictEqual(format_relative_time(new Date('2026-01-15T12:00:00Z'), now), '5m ago');
	});
});

describe('format_uptime', () => {
	test('formats seconds', () => {
		assert.strictEqual(format_uptime(0), '0s');
		assert.strictEqual(format_uptime(1000), '1s');
		assert.strictEqual(format_uptime(45000), '45s');
		assert.strictEqual(format_uptime(59999), '59s');
	});

	test('formats minutes', () => {
		assert.strictEqual(format_uptime(60000), '1m');
		assert.strictEqual(format_uptime(720000), '12m');
		assert.strictEqual(format_uptime(3599999), '59m');
	});

	test('formats hours', () => {
		assert.strictEqual(format_uptime(3600000), '1h');
		assert.strictEqual(format_uptime(7200000), '2h');
	});

	test('formats hours with remaining minutes', () => {
		assert.strictEqual(format_uptime(5400000), '1h 30m');
		assert.strictEqual(format_uptime(11700000), '3h 15m');
	});

	test('formats days', () => {
		assert.strictEqual(format_uptime(86400000), '1d');
		assert.strictEqual(format_uptime(172800000), '2d');
	});

	test('formats days with remaining hours', () => {
		assert.strictEqual(format_uptime(90000000), '1d 1h');
		assert.strictEqual(format_uptime(183600000), '2d 3h');
	});

	test('formats negative input using absolute value', () => {
		assert.strictEqual(format_uptime(-5000), '-5s');
		assert.strictEqual(format_uptime(-120000), '-2m');
		assert.strictEqual(format_uptime(-7200000), '-2h');
	});

	test('formats sub-second as 0s', () => {
		assert.strictEqual(format_uptime(500), '0s');
		assert.strictEqual(format_uptime(999), '0s');
	});
});

describe('truncate_middle', () => {
	test('returns original string when within max length', () => {
		assert.strictEqual(truncate_middle('short', 10), 'short');
	});

	test('returns original string when exactly max length', () => {
		assert.strictEqual(truncate_middle('12345', 5), '12345');
	});

	test('truncates with ellipsis in the middle', () => {
		assert.strictEqual(truncate_middle('abcdefghij', 7), 'abc…hij');
	});

	test('handles even split', () => {
		assert.strictEqual(truncate_middle('abcdefgh', 5), 'ab…gh');
	});

	test('favors start when odd available chars', () => {
		assert.strictEqual(truncate_middle('abcdefgh', 6), 'abc…gh');
	});

	test('handles UUID-length strings', () => {
		const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
		const result = truncate_middle(uuid, 12);
		assert.strictEqual(result.length, 12);
		assert.ok(result.startsWith('a1b2c'));
		assert.ok(result.endsWith('7890'));
	});

	test('custom separator', () => {
		assert.strictEqual(truncate_middle('abcdefghij', 7, '..'), 'abc..ij');
	});

	test('handles max_length smaller than separator', () => {
		assert.strictEqual(truncate_middle('abcdefgh', 0), '');
	});

	test('multi-char separator truncated to max_length', () => {
		assert.strictEqual(truncate_middle('abcdefgh', 2, '...'), '..');
		assert.strictEqual(truncate_middle('abcdefgh', 1, '...'), '.');
	});
});

describe('truncate_uuid', () => {
	test('truncates a UUID to 12 characters', () => {
		const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
		const result = truncate_uuid(uuid);
		assert.strictEqual(result.length, 12);
		assert.ok(result.includes('…'));
	});

	test('passes through short strings unchanged', () => {
		assert.strictEqual(truncate_uuid('short'), 'short');
	});
});

describe('format_datetime_local', () => {
	test('formats ISO string to readable UTC datetime', () => {
		assert.strictEqual(
			format_datetime_local('2026-03-21T14:30:00.000Z'),
			'2026-03-21 14:30:00 UTC',
		);
	});

	test('formats Date object', () => {
		assert.strictEqual(
			format_datetime_local(new Date('2026-01-15T08:00:00.000Z')),
			'2026-01-15 08:00:00 UTC',
		);
	});

	test('formats numeric timestamp', () => {
		const ms = new Date('2026-06-01T12:00:00.000Z').getTime();
		assert.strictEqual(format_datetime_local(ms), '2026-06-01 12:00:00 UTC');
	});

	test('returns empty string for invalid date', () => {
		assert.strictEqual(format_datetime_local('garbage'), '');
	});

	test('strips sub-second precision', () => {
		assert.strictEqual(
			format_datetime_local('2026-03-21T14:30:45.123Z'),
			'2026-03-21 14:30:45 UTC',
		);
	});
});

describe('format_audit_metadata', () => {
	test('returns empty string for null metadata', () => {
		assert.strictEqual(format_audit_metadata('login', null), '');
	});

	test('login shows username', () => {
		assert.strictEqual(format_audit_metadata('login', {username: 'alice'}), 'user: alice');
	});

	test('login returns empty for missing username', () => {
		assert.strictEqual(format_audit_metadata('login', {}), '');
	});

	test('logout returns empty', () => {
		assert.strictEqual(format_audit_metadata('logout', {}), '');
	});

	test('bootstrap shows error', () => {
		assert.strictEqual(
			format_audit_metadata('bootstrap', {error: 'db failed'}),
			'error: db failed',
		);
	});

	test('bootstrap returns empty without error', () => {
		assert.strictEqual(format_audit_metadata('bootstrap', {}), '');
	});

	test('signup combines fields', () => {
		assert.strictEqual(
			format_audit_metadata('signup', {username: 'bob', invite_id: 'inv_1', open_signup: false}),
			'user: bob, via invite',
		);
	});

	test('signup with open signup', () => {
		assert.strictEqual(
			format_audit_metadata('signup', {username: 'bob', open_signup: true}),
			'user: bob, open signup',
		);
	});

	test('password_change shows sessions revoked', () => {
		assert.strictEqual(
			format_audit_metadata('password_change', {sessions_revoked: 3}),
			'3 sessions revoked',
		);
	});

	test('session_revoke truncates session_id', () => {
		const result = format_audit_metadata('session_revoke', {
			session_id: 'abcdef1234567890abcdef1234567890',
		});
		assert.ok(result.startsWith('session: '));
		assert.ok(result.length < 30);
	});

	test('session_revoke_all shows count', () => {
		assert.strictEqual(format_audit_metadata('session_revoke_all', {count: 5}), '5 sessions');
	});

	test('token_create shows name', () => {
		assert.strictEqual(format_audit_metadata('token_create', {name: 'My Token'}), '"My Token"');
	});

	test('token_revoke truncates token_id', () => {
		const result = format_audit_metadata('token_revoke', {
			token_id: 'tok_abcdef1234567890',
		});
		assert.ok(result.startsWith('token: '));
	});

	test('token_revoke_all shows count', () => {
		assert.strictEqual(format_audit_metadata('token_revoke_all', {count: 2}), '2 tokens');
	});

	test('permit_grant shows role', () => {
		assert.strictEqual(format_audit_metadata('permit_grant', {role: 'admin'}), 'role: admin');
	});

	test('permit_revoke shows role', () => {
		assert.strictEqual(format_audit_metadata('permit_revoke', {role: 'viewer'}), 'role: viewer');
	});

	test('invite_create combines email and username', () => {
		assert.strictEqual(
			format_audit_metadata('invite_create', {email: 'a@b.com', username: 'alice'}),
			'email: a@b.com, user: alice',
		);
	});

	test('invite_create with only email', () => {
		assert.strictEqual(
			format_audit_metadata('invite_create', {email: 'a@b.com'}),
			'email: a@b.com',
		);
	});

	test('invite_delete truncates invite_id', () => {
		const result = format_audit_metadata('invite_delete', {
			invite_id: 'abcdef1234567890abcdef1234567890',
		});
		assert.ok(result.startsWith('invite: '));
	});

	test('app_settings_update shows setting change', () => {
		assert.strictEqual(
			format_audit_metadata('app_settings_update', {
				setting: 'open_signup',
				old_value: false,
				new_value: true,
			}),
			'open_signup: false → true',
		);
	});
});

describe('format_value', () => {
	test('null returns NULL', () => {
		assert.strictEqual(format_value(null), 'NULL');
	});

	test('string passes through unchanged', () => {
		assert.strictEqual(format_value('hello'), 'hello');
	});

	test('number returns string representation', () => {
		assert.strictEqual(format_value(42), '42');
	});

	test('boolean true returns "true"', () => {
		assert.strictEqual(format_value(true), 'true');
	});

	test('boolean false returns "false"', () => {
		assert.strictEqual(format_value(false), 'false');
	});

	test('object returns JSON string', () => {
		assert.strictEqual(format_value({a: 1}), '{"a":1}');
	});

	test('undefined returns "undefined"', () => {
		assert.strictEqual(format_value(undefined), 'undefined');
	});

	test('array returns JSON string', () => {
		assert.strictEqual(format_value([1, 2, 3]), '[1,2,3]');
	});

	test('empty string passes through', () => {
		assert.strictEqual(format_value(''), '');
	});

	test('zero returns "0"', () => {
		assert.strictEqual(format_value(0), '0');
	});

	test('NaN returns "NaN"', () => {
		assert.strictEqual(format_value(NaN), 'NaN');
	});
});
