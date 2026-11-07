/**
 * The builtin `audit_metadata_schemas`: a valid metadata value of each event
 * type, and the issue shapes that differ from the schemas they were ported
 * from, pinned case by case.
 *
 * - **the object kind**: a value that is no object gets an issue of kind
 *   `loose_object`, its `expected` `object`.
 * - **the email bound**: a `signup` `email` past `EMAIL_LENGTH_MAX` code
 *   units gets one `max_length` issue, with `EMAIL_LENGTH_MESSAGE`.
 *
 * Insert-time validation is fail-open, so these reach only the drift counter
 * and its log line.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { is_schema } from '@fuzdev/fuz_schema/schema.ts';

import { EMAIL_LENGTH_MAX, EMAIL_LENGTH_MESSAGE } from '#lib/primitive_schemas.ts';
import {
	AUDIT_EVENT_TYPES,
	audit_metadata_schemas,
	type AuditEventType
} from '#lib/auth/audit_log_schema.ts';
import { parse_any, to_wire_issues, type WireIssue } from '#lib/schema_issues.ts';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const HASH = 'a'.repeat(64);
const TOKEN = 'tok_abcdefghijkl';

/** A valid metadata value of each builtin event type. */
const BASES: Record<AuditEventType, unknown> = {
	login: { username: 'alice' },
	logout: null,
	bootstrap: { error: 'x' },
	signup: { username: 'alice' },
	password_change: {},
	session_revoke: { session_id: HASH },
	session_revoke_all: {},
	token_create: { token_id: TOKEN, name: 'cli' },
	token_revoke: { token_id: TOKEN },
	token_revoke_all: {},
	role_grant_create: { role: 'admin' },
	role_grant_revoke: { role: 'admin', role_grant_id: ID },
	role_grant_offer_create: { role: 'teacher', to_account_id: ID },
	role_grant_offer_accept: { offer_id: ID, role: 'teacher' },
	role_grant_offer_decline: { offer_id: ID, role: 'teacher' },
	role_grant_offer_retract: { offer_id: ID, role: 'teacher' },
	role_grant_offer_expire: { offer_id: ID, role: 'teacher' },
	role_grant_offer_supersede: {
		offer_id: ID,
		role: 'teacher',
		reason: 'sibling_accepted',
		cause_id: ID
	},
	invite_create: { invite_id: ID, email: null, username: 'bob' },
	invite_delete: { invite_id: ID },
	account_delete: {},
	account_purge: {},
	account_undelete: {},
	actor_delete: {},
	actor_purge: {},
	actor_undelete: {},
	app_settings_update: { setting: 'open_signup', old_value: false, new_value: true },
	db_admin_row_delete: { table: 't', pk_column: 'id', id: '1' }
};

const issues_of = (event_type: AuditEventType, input: unknown): Array<WireIssue> | null => {
	const result = parse_any(audit_metadata_schemas[event_type], input);
	return result.ok ? null : to_wire_issues(result.issues, input);
};

describe('the builtin audit metadata schemas', () => {
	test('cover every builtin event type, each a fuz_schema schema', () => {
		assert.deepStrictEqual(Object.keys(audit_metadata_schemas), [...AUDIT_EVENT_TYPES]);
		assert.deepStrictEqual(Object.keys(BASES), [...AUDIT_EVENT_TYPES]);
		for (const schema of Object.values(audit_metadata_schemas)) assert.ok(is_schema(schema));
	});

	test('each takes its valid metadata value, returned as it is', () => {
		for (const event_type of AUDIT_EVENT_TYPES) {
			const base = BASES[event_type];
			const result = parse_any(audit_metadata_schemas[event_type], base);
			assert.ok(result.ok, event_type);
			assert.strictEqual(result.value, base, event_type);
		}
	});

	test('unknown keys pass through', () => {
		const metadata = { username: 'alice', extra: { nested: [1] } };
		const result = parse_any(audit_metadata_schemas.login, metadata);
		assert.ok(result.ok);
		assert.deepStrictEqual(result.value, metadata);
	});

	test('a value that is no object gets a loose_object issue', () => {
		const cases: ReadonlyArray<[AuditEventType, unknown, string]> = [
			['login', 'x', 'string'],
			['login', [], 'array'],
			['signup', 1, 'number'],
			['signup', null, 'null'],
			['session_revoke', 'x', 'string']
		];
		for (const [event_type, input, received] of cases) {
			const issues = issues_of(event_type, input);
			assert.ok(issues, `${event_type} ${String(input)}`);
			assert.deepStrictEqual(
				issues.map((i) => [i.kind, i.path, i.expected, i.received]),
				[['loose_object', [], 'object', received]],
				`${event_type} ${String(input)}`
			);
		}
		// the nullable ones take null
		assert.isNull(issues_of('login', null));
		assert.isNull(issues_of('password_change', null));
	});

	test('a signup email past the code-unit bound gets one max_length issue', () => {
		assert.isNull(issues_of('signup', { username: 'alice', email: 'user@example.com' }));
		for (const email of ['a'.repeat(EMAIL_LENGTH_MAX + 1), `${'a'.repeat(300)}@example.com`]) {
			assert.deepStrictEqual(issues_of('signup', { username: 'alice', email }), [
				{
					kind: 'max_length',
					path: ['email'],
					expected: `length <= ${EMAIL_LENGTH_MAX}`,
					received: 'string',
					message: `email: ${EMAIL_LENGTH_MESSAGE}`
				}
			]);
		}
	});
});
