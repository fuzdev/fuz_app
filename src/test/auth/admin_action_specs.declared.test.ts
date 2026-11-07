/**
 * The admin domain's schemas — every input of `all_admin_action_specs`, the
 * row-free outputs, and the app settings schemas: their valid samples, and
 * the verdicts and issue shapes that differ from the schemas they were ported
 * from, pinned case by case. The outputs that hold a row are pinned in
 * `row_schemas.declared.test.ts`.
 *
 * - **the trailing check**: `invite_create`'s at-least-one check runs only on
 *   an input whose fields passed, so a field failure gets its own issue alone.
 * - **one length issue**: a `username` outside its bounds and off the grammar,
 *   or an `event_type` too long and off it, gets the length issue alone.
 * - **the email bound**: an `email` past `EMAIL_LENGTH_MAX` code units gets
 *   one `max_length` issue with `EMAIL_LENGTH_MESSAGE`; one within the code
 *   units, past the bytes and off the grammar gets the grammar issue; one on
 *   the grammar past the bytes gets the byte `check` with that message.
 * - **the array username**: a `username` that is an array gets the type issue
 *   alone, whatever its length.
 * - **one bound issue**: a `limit` past `Number.MAX_SAFE_INTEGER` gets the
 *   `max_value` issue of its bound alone.
 * - **the count**: the revoke-all outputs' `count` is a non-negative integer.
 *
 * A custom message is kept behind the issue's path.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { is_schema, parse, type AnySchema } from '@fuzdev/fuz_schema/schema.ts';

import {
	EMAIL_LENGTH_MAX,
	EMAIL_LENGTH_MESSAGE,
	EMAIL_REGEX,
	USERNAME_LENGTH_MAX
} from '#lib/primitive_schemas.ts';
import {
	AUDIT_EVENT_TYPE_NAME_LENGTH_MESSAGE,
	AUDIT_EVENT_TYPE_NAME_PATTERN_MESSAGE
} from '#lib/auth/audit_log_schema.ts';
import { AppSettingsJson, AppSettingsWithUsernameJson } from '#lib/auth/app_settings_schema.ts';
import {
	ADMIN_ACCOUNT_LIST_LIMIT_MAX,
	AUDIT_LOG_LIST_LIMIT_MAX,
	AccountDeleteInput,
	AccountDeleteOutput,
	AccountPurgeInput,
	AccountPurgeOutput,
	AccountUndeleteInput,
	AccountUndeleteOutput,
	AdminAccountListInput,
	AdminSessionListInput,
	AdminSessionRevokeAllInput,
	AdminSessionRevokeAllOutput,
	AdminTokenRevokeAllInput,
	AdminTokenRevokeAllOutput,
	AppSettingsGetInput,
	AppSettingsGetOutput,
	AppSettingsUpdateInput,
	AppSettingsUpdateOutput,
	AuditLogListInput,
	AuditLogRoleGrantHistoryInput,
	INVITE_TARGET_REQUIRED_MESSAGE,
	InviteCreateInput,
	InviteDeleteInput,
	InviteDeleteOutput,
	InviteListInput,
	all_admin_action_specs
} from '#lib/auth/admin_action_specs.ts';
import { to_wire_issues, type WireIssue } from '#lib/schema_issues.ts';
import { NAME_LENGTH_MAX } from '#lib/auth/name_schema.ts';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const NOW = '2026-11-05T12:00:00.000Z';

const issues_of = (schema: AnySchema, input: unknown): Array<WireIssue> | null => {
	const result = parse(schema, input);
	return result.ok ? null : to_wire_issues(result.issues);
};

/** The issues as `[kind, path, expected]`, or `null` for an acceptance. */
const shape_of = (schema: AnySchema, input: unknown): Array<unknown> | null =>
	issues_of(schema, input)?.map((i) => [i.kind, i.path, i.expected]) ?? null;

const settings = {
	open_signup: true,
	updated_at: NOW,
	updated_by: ID,
	updated_by_username: 'alice'
};

const samples: ReadonlyArray<[string, AnySchema, ReadonlyArray<unknown>]> = [
	[
		'InviteCreateInput',
		InviteCreateInput,
		[{ email: 'user@example.com' }, { username: 'alice' }, { email: 'a@b.c', acting: ID }]
	],
	[
		'AdminAccountListInput',
		AdminAccountListInput,
		[undefined, {}, { limit: ADMIN_ACCOUNT_LIST_LIMIT_MAX, offset: 0, include_deleted: true }]
	],
	[
		'AuditLogListInput',
		AuditLogListInput,
		[
			{},
			{
				event_type: 'app.thing/created-v2',
				outcome: 'failure',
				account_id: ID,
				limit: AUDIT_LOG_LIST_LIMIT_MAX,
				since_seq: Number.MAX_SAFE_INTEGER
			}
		]
	],
	['AuditLogRoleGrantHistoryInput', AuditLogRoleGrantHistoryInput, [{}, { limit: 1, offset: 3 }]],
	['AdminSessionListInput', AdminSessionListInput, [undefined, {}, { acting: ID }]],
	['InviteListInput', InviteListInput, [{}]],
	['AppSettingsGetInput', AppSettingsGetInput, [{}]],
	['AdminSessionRevokeAllInput', AdminSessionRevokeAllInput, [{ account_id: ID }]],
	['AdminTokenRevokeAllInput', AdminTokenRevokeAllInput, [{ account_id: ID }]],
	['AccountUndeleteInput', AccountUndeleteInput, [{ account_id: ID }]],
	['InviteDeleteInput', InviteDeleteInput, [{ invite_id: ID }]],
	['AccountDeleteInput', AccountDeleteInput, [{}, { account_id: null }, { account_id: ID }]],
	['AccountPurgeInput', AccountPurgeInput, [{ account_id: ID, confirm: true }, { account_id: ID }]],
	['AppSettingsUpdateInput', AppSettingsUpdateInput, [{ open_signup: false }]],
	['AdminSessionRevokeAllOutput', AdminSessionRevokeAllOutput, [{ ok: true, count: 0 }]],
	['AdminTokenRevokeAllOutput', AdminTokenRevokeAllOutput, [{ ok: true, count: 3 }]],
	['InviteDeleteOutput', InviteDeleteOutput, [{ ok: true }]],
	['AccountDeleteOutput', AccountDeleteOutput, [{ ok: true, deleted: false }]],
	['AccountPurgeOutput', AccountPurgeOutput, [{ ok: true, purged: true }]],
	['AccountUndeleteOutput', AccountUndeleteOutput, [{ ok: true, undeleted: true }]],
	[
		'AppSettingsJson',
		AppSettingsJson,
		[
			{ open_signup: true, updated_at: NOW, updated_by: ID },
			{ open_signup: false, updated_at: null, updated_by: null }
		]
	],
	['AppSettingsWithUsernameJson', AppSettingsWithUsernameJson, [settings]],
	['AppSettingsGetOutput', AppSettingsGetOutput, [{ settings }]],
	['AppSettingsUpdateOutput', AppSettingsUpdateOutput, [{ ok: true, settings }]]
];

describe('the admin schemas', () => {
	test('every input and output of all_admin_action_specs is a fuz_schema schema', () => {
		for (const spec of all_admin_action_specs) {
			assert.ok(is_schema(spec.input), spec.method);
			assert.ok(is_schema(spec.output), spec.method);
		}
	});

	test.each(samples)('%s takes every valid sample', (_name, schema, values) => {
		for (const value of values) {
			assert.ok(parse(schema, value).ok, JSON.stringify(value));
		}
	});

	test('an omitted defaulted input reads as a fresh {}', () => {
		for (const schema of [
			AdminAccountListInput,
			AdminSessionListInput,
			AuditLogListInput,
			AuditLogRoleGrantHistoryInput,
			InviteListInput,
			AccountDeleteInput,
			AppSettingsGetInput
		]) {
			const a = parse(schema, undefined);
			const b = parse(schema, undefined);
			assert.ok(a.ok && b.ok);
			assert.deepStrictEqual(a.value, {});
			assert.notStrictEqual(a.value, b.value);
		}
	});

	test('the safe range bounds offset and since_seq', () => {
		for (const value of [Number.MAX_SAFE_INTEGER + 1, 2 ** 53 + 2, 1e16]) {
			assert.ok(!parse(AdminAccountListInput, { offset: value }).ok, String(value));
			assert.ok(!parse(AuditLogListInput, { since_seq: value }).ok, String(value));
		}
		assert.ok(parse(AuditLogListInput, { since_seq: Number.MAX_SAFE_INTEGER }).ok);
	});
});

describe('the declared differences, pinned', () => {
	test('invite_create given neither target fails at email with its message', () => {
		for (const input of [
			{},
			{ email: null },
			{ username: undefined },
			{ email: null, username: null }
		]) {
			assert.deepStrictEqual(issues_of(InviteCreateInput, input), [
				{
					kind: 'check',
					path: ['email'],
					expected: 'check',
					received: input.email === null ? 'null' : 'undefined',
					message: `email: ${INVITE_TARGET_REQUIRED_MESSAGE}`
				}
			]);
		}
	});

	test('the trailing check: a field failure beside no target gets its own issue alone', () => {
		assert.isNull(issues_of(InviteCreateInput, { email: 'user@example.com', acting: ID }));
		assert.deepStrictEqual(shape_of(InviteCreateInput, { acting: 'x' }), [
			['uuid', ['acting'], 'uuid']
		]);
		assert.deepStrictEqual(shape_of(InviteCreateInput, { extra: 1 }), [
			['unknown_key', ['extra'], 'no unknown keys']
		]);
		assert.deepStrictEqual(shape_of(InviteCreateInput, { email: null, username: null, extra: 1 }), [
			['unknown_key', ['extra'], 'no unknown keys']
		]);
	});

	test('one length issue: a username or event_type out of bounds and off the grammar', () => {
		assert.isNull(issues_of(InviteCreateInput, { username: 'a'.repeat(USERNAME_LENGTH_MAX) }));
		assert.deepStrictEqual(shape_of(InviteCreateInput, { username: 'a' }), [
			['min_length', ['username'], 'length >= 3']
		]);
		assert.deepStrictEqual(
			shape_of(InviteCreateInput, { username: '1'.repeat(USERNAME_LENGTH_MAX + 1) }),
			[['max_length', ['username'], `length <= ${USERNAME_LENGTH_MAX}`]]
		);
		assert.isNull(issues_of(AuditLogListInput, { event_type: 'a'.repeat(NAME_LENGTH_MAX) }));
		const long_off = '1'.repeat(NAME_LENGTH_MAX + 1);
		assert.deepStrictEqual(
			issues_of(AuditLogListInput, { event_type: long_off })?.map((i) => [i.kind, i.message]),
			[['max_length', `event_type: ${AUDIT_EVENT_TYPE_NAME_LENGTH_MESSAGE}`]]
		);
		assert.deepStrictEqual(
			issues_of(AuditLogListInput, { event_type: '1login' })?.map((i) => [i.kind, i.message]),
			[['regex', `event_type: ${AUDIT_EVENT_TYPE_NAME_PATTERN_MESSAGE}`]]
		);
	});

	test('the email bound: code units, then the grammar, then the bytes', () => {
		assert.isNull(issues_of(InviteCreateInput, { email: 'user@example.com' }));
		assert.isNull(issues_of(InviteCreateInput, { email: `${'ü'.repeat(121)}@example.com` }));
		const max_issue = {
			kind: 'max_length',
			path: ['email'],
			expected: `length <= ${EMAIL_LENGTH_MAX}`,
			received: 'string',
			message: `email: ${EMAIL_LENGTH_MESSAGE}`
		};
		assert.deepStrictEqual(
			issues_of(InviteCreateInput, { email: 'a'.repeat(EMAIL_LENGTH_MAX + 1) }),
			[max_issue]
		);
		assert.deepStrictEqual(
			issues_of(InviteCreateInput, { email: `${'a'.repeat(EMAIL_LENGTH_MAX - 11)}@example.com` }),
			[max_issue]
		);
		// within the code units, past the bytes, off the grammar: the grammar issue
		assert.deepStrictEqual(shape_of(InviteCreateInput, { email: 'ü'.repeat(130) }), [
			['regex', ['email'], String(EMAIL_REGEX)]
		]);
		// on the grammar, past the bytes: the byte check, its message kept
		assert.deepStrictEqual(
			issues_of(InviteCreateInput, { email: `${'ü'.repeat(122)}@example.com` }),
			[
				{
					kind: 'check',
					path: ['email'],
					expected: 'check',
					received: 'string',
					message: `email: ${EMAIL_LENGTH_MESSAGE}`
				}
			]
		);
	});

	test('the array username gets the type issue alone', () => {
		for (const username of [
			[],
			['a'],
			Array.from({ length: USERNAME_LENGTH_MAX + 1 }, () => 'a')
		]) {
			assert.deepStrictEqual(shape_of(InviteCreateInput, { username }), [
				['string', ['username'], 'string']
			]);
		}
	});

	test("one bound issue: a limit past the safe range gets its bound's issue alone", () => {
		assert.isNull(issues_of(AdminAccountListInput, { limit: ADMIN_ACCOUNT_LIST_LIMIT_MAX }));
		for (const limit of [Number.MAX_SAFE_INTEGER + 1, 1e308]) {
			assert.deepStrictEqual(shape_of(AdminAccountListInput, { limit }), [
				['max_value', ['limit'], `<= ${ADMIN_ACCOUNT_LIST_LIMIT_MAX}`]
			]);
			assert.deepStrictEqual(shape_of(AuditLogListInput, { limit }), [
				['max_value', ['limit'], `<= ${AUDIT_LOG_LIST_LIMIT_MAX}`]
			]);
		}
	});

	test('the revoke-all count is a non-negative integer', () => {
		for (const schema of [AdminSessionRevokeAllOutput, AdminTokenRevokeAllOutput]) {
			for (const count of [0, 3, -0, Number.MAX_SAFE_INTEGER]) {
				assert.ok(parse(schema, { ok: true, count }).ok, String(count));
			}
			assert.deepStrictEqual(shape_of(schema, { ok: true, count: 1.5 }), [
				['integer', ['count'], 'integer']
			]);
			assert.deepStrictEqual(shape_of(schema, { ok: true, count: -1 }), [
				['min_value', ['count'], '>= 0']
			]);
			for (const count of [-0.5, Number.MIN_VALUE]) {
				assert.ok(!parse(schema, { ok: true, count }).ok, String(count));
			}
		}
	});
});
