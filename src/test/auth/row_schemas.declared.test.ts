/**
 * The row schemas of the account, session, audit and invite outputs —
 * `SessionAccountJson`, `AuthSessionJson`, `RoleGrantSummaryJson`,
 * `ActorSummaryJson`, `AdminAccountJson`, `PendingOfferSummaryJson`,
 * `AdminAccountEntryJson`, `AdminSessionJson`, `AuditLogEventJson`,
 * `AuditLogEventWithUsernamesJson`, `RoleGrantHistoryEventJson`, `InviteJson`
 * and `InviteWithUsernamesJson`, the outputs, input and SSE params that hold
 * them, and `SessionId`: their valid samples, and the verdicts and issue
 * shapes that differ from the schemas they were ported from, pinned case by
 * case.
 *
 * - **the strict timestamp**: a timestamp is `Timestamp`, an RFC 3339 date
 *   and time in UTC. Both spines write `YYYY-MM-DDTHH:MM:SSZ`.
 * - **the canonical username**: an account's or an invite's `username` is
 *   `UsernameCanonical`, so one with an uppercase letter fails with the
 *   lowercase grammar's `regex` issue. Both spines store every username
 *   lowercase, which the `account_username_lowercase` CHECK holds.
 * - **the strict names**: a grant's or an offer's `role` is a `RoleName` and
 *   its `scope_kind` a `ScopeKindName` or `null`.
 * - **one length issue**, **the array username** and **the email bound**, as
 *   in `admin_action_specs.declared.test.ts`.
 * - **the safe-integer issue**: a `seq` that is a finite number but no safe
 *   integer gets one `safe_integer` issue.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { is_schema, parse, type AnySchema } from '@fuzdev/fuz_schema/schema.ts';

import {
	BLAKE3_HASH_MESSAGE,
	BLAKE3_HASH_REGEX,
	EMAIL_LENGTH_MAX,
	EMAIL_LENGTH_MESSAGE,
	EMAIL_REGEX,
	USERNAME_LENGTH_MAX,
	USERNAME_CANONICAL_REGEX
} from '#lib/primitive_schemas.ts';
import { NAME_LENGTH_MAX, NAME_REGEX } from '#lib/auth/name_schema.ts';
import {
	ActorSummaryJson,
	AdminAccountEntryJson,
	AdminAccountJson,
	AuthSessionJson,
	PendingOfferSummaryJson,
	RoleGrantSummaryJson,
	SessionAccountJson,
	SessionId
} from '#lib/auth/account_schema.ts';
import {
	AdminSessionJson,
	AUDIT_EVENT_TYPE_NAME_LENGTH_MESSAGE,
	AuditLogEventJson,
	AuditLogEventWithUsernamesJson,
	RoleGrantHistoryEventJson
} from '#lib/auth/audit_log_schema.ts';
import { audit_log_event_specs } from '#lib/realtime/audit_log_sse.ts';
import {
	SessionListOutput,
	SessionRevokeInput,
	account_verify_action_spec
} from '#lib/auth/account_action_specs.ts';
import { AccountStatusOutput } from '#lib/auth/account_route_schema.ts';
import {
	AdminAccountListOutput,
	AdminSessionListOutput,
	AuditLogListOutput,
	AuditLogRoleGrantHistoryOutput,
	InviteCreateOutput,
	InviteListOutput
} from '#lib/auth/admin_action_specs.ts';
import { InviteJson, InviteWithUsernamesJson } from '#lib/auth/invite_schema.ts';
import { to_wire_issues, type WireIssue } from '#lib/schema_issues.ts';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const NOW = '2026-11-05T12:00:00Z';
const HASH = 'a'.repeat(64);

const SESSION_ACCOUNT = {
	id: ID,
	username: 'alice',
	email: 'alice@example.com',
	email_verified: false,
	created_at: NOW
};
const ADMIN_ACCOUNT = { ...SESSION_ACCOUNT, updated_at: NOW, updated_by: null, deleted_at: null };
const SESSION = { id: HASH, account_id: ID, created_at: NOW, expires_at: NOW, is_current: true };
const ADMIN_SESSION = { id: HASH, account_id: ID, created_at: NOW, expires_at: NOW, username: 'x' };
const GRANT = {
	id: ID,
	role: 'teacher',
	scope_kind: 'classroom',
	scope_id: ID2,
	created_at: NOW,
	expires_at: null,
	granted_by: null
};
const ACTOR = { id: ID, name: 'alice' };
const OFFER = {
	id: ID,
	role: 'teacher',
	scope_kind: null,
	scope_id: null,
	from_actor_id: ID2,
	from_username: 'bob',
	created_at: NOW,
	expires_at: NOW
};
const AUDIT_EVENT = {
	id: ID,
	seq: 1,
	event_type: 'login',
	outcome: 'success',
	actor_id: null,
	account_id: ID,
	target_account_id: null,
	target_actor_id: null,
	ip: '127.0.0.1',
	created_at: NOW,
	metadata: { username: 'alice' }
};
const WITH_USERNAMES = { ...AUDIT_EVENT, username: 'alice', target_username: null };
const INVITE = {
	id: ID,
	email: 'bob@example.com',
	username: 'bob',
	claimed_by: null,
	claimed_at: null,
	created_at: NOW,
	created_by: ID2
};
const INVITE_WITH_USERNAMES = {
	...INVITE,
	created_by_username: 'alice',
	claimed_by_username: null
};
const ENTRY = {
	account: ADMIN_ACCOUNT,
	actor: ACTOR,
	role_grants: [GRANT],
	pending_offers: [OFFER]
};

/** The rows holding a `username` and an `email`, each with a valid value. */
const USERNAME_HOLDERS: ReadonlyArray<[AnySchema, Record<string, unknown>]> = [
	[SessionAccountJson, SESSION_ACCOUNT],
	[InviteJson, INVITE]
];

const issues_of = (schema: AnySchema, input: unknown): Array<WireIssue> | null => {
	const result = parse(schema, input);
	return result.ok ? null : to_wire_issues(result.issues, input);
};

/** The issues as `[kind, path, expected]`, or `null` for an acceptance. */
const shape_of = (schema: AnySchema, input: unknown): Array<unknown> | null =>
	issues_of(schema, input)?.map((i) => [i.kind, i.path, i.expected]) ?? null;

const samples: ReadonlyArray<[string, AnySchema, ReadonlyArray<unknown>]> = [
	['SessionId', SessionId, [HASH, '0'.repeat(64)]],
	[
		'SessionAccountJson',
		SessionAccountJson,
		[SESSION_ACCOUNT, { ...SESSION_ACCOUNT, username: 'a-b_c', email: null }]
	],
	['AuthSessionJson', AuthSessionJson, [SESSION]],
	[
		'RoleGrantSummaryJson',
		RoleGrantSummaryJson,
		[GRANT, { ...GRANT, scope_kind: null, scope_id: null }]
	],
	['ActorSummaryJson', ActorSummaryJson, [ACTOR]],
	['AdminAccountJson', AdminAccountJson, [ADMIN_ACCOUNT, { ...ADMIN_ACCOUNT, deleted_at: NOW }]],
	['PendingOfferSummaryJson', PendingOfferSummaryJson, [OFFER]],
	[
		'AdminAccountEntryJson',
		AdminAccountEntryJson,
		[ENTRY, { ...ENTRY, actor: null, role_grants: [], pending_offers: [] }]
	],
	['AdminSessionJson', AdminSessionJson, [ADMIN_SESSION]],
	['SessionListOutput', SessionListOutput, [{ sessions: [] }, { sessions: [SESSION] }]],
	['SessionRevokeInput', SessionRevokeInput, [{ session_id: HASH }]],
	[
		'AccountStatusOutput',
		AccountStatusOutput,
		[{ account: SESSION_ACCOUNT, actor: ACTOR, role_grants: [GRANT] }]
	],
	[
		'AdminAccountListOutput',
		AdminAccountListOutput,
		[
			{ accounts: [ENTRY], grantable_roles: ['admin'] },
			{ accounts: [], grantable_roles: [] }
		]
	],
	['AdminSessionListOutput', AdminSessionListOutput, [{ sessions: [ADMIN_SESSION] }]],
	[
		'AuditLogEventJson',
		AuditLogEventJson,
		[AUDIT_EVENT, { ...AUDIT_EVENT, seq: 0, event_type: 'app.thing/created-v2', metadata: null }]
	],
	['AuditLogEventWithUsernamesJson', AuditLogEventWithUsernamesJson, [WITH_USERNAMES]],
	['RoleGrantHistoryEventJson', RoleGrantHistoryEventJson, [WITH_USERNAMES]],
	['AuditLogListOutput', AuditLogListOutput, [{ events: [] }, { events: [WITH_USERNAMES] }]],
	[
		'AuditLogRoleGrantHistoryOutput',
		AuditLogRoleGrantHistoryOutput,
		[{ events: [WITH_USERNAMES] }]
	],
	['InviteJson', InviteJson, [INVITE, { ...INVITE, email: null, username: null }]],
	['InviteWithUsernamesJson', InviteWithUsernamesJson, [INVITE_WITH_USERNAMES]],
	['InviteCreateOutput', InviteCreateOutput, [{ ok: true, invite: INVITE }]],
	['InviteListOutput', InviteListOutput, [{ invites: [] }, { invites: [INVITE_WITH_USERNAMES] }]]
];

describe('the row schemas', () => {
	test.each(samples)(
		'%s is a fuz_schema schema taking every valid sample',
		(_name, schema, values) => {
			assert.ok(is_schema(schema));
			for (const value of values) {
				assert.ok(parse(schema, value).ok, JSON.stringify(value));
			}
		}
	);

	test('account_verify answers a SessionAccountJson and every audit SSE event a row', () => {
		assert.strictEqual(account_verify_action_spec.output, SessionAccountJson);
		for (const spec of audit_log_event_specs) {
			assert.strictEqual(spec.params, AuditLogEventJson, spec.method);
		}
	});

	test('a SessionId off the grammar keeps its message, behind the path', () => {
		assert.deepStrictEqual(issues_of(SessionId, 'A'.repeat(64)), [
			{
				kind: 'regex',
				path: [],
				expected: String(BLAKE3_HASH_REGEX),
				received: 'string',
				message: BLAKE3_HASH_MESSAGE
			}
		]);
		for (const id of ['g'.repeat(64), 'a'.repeat(63)]) {
			assert.deepStrictEqual(
				issues_of(AuthSessionJson, { ...SESSION, id })?.map((i) => [i.kind, i.message]),
				[['regex', `id: ${BLAKE3_HASH_MESSAGE}`]]
			);
			assert.deepStrictEqual(
				issues_of(SessionRevokeInput, { session_id: id })?.map((i) => [i.kind, i.message]),
				[['regex', `session_id: ${BLAKE3_HASH_MESSAGE}`]]
			);
		}
	});
});

describe('the declared differences, pinned', () => {
	test('a timestamp is an RFC 3339 date and time in UTC', () => {
		for (const t of ['2026-11-05T12:00:00.123Z', '2024-02-29T23:59:59Z']) {
			assert.isNull(issues_of(SessionAccountJson, { ...SESSION_ACCOUNT, created_at: t }), t);
		}
		for (const t of [
			'2026-11-05T12:00:00+00:00',
			'2026-11-05 12:00:00+00',
			'2026-11-05T12:00Z',
			'2026-02-30T00:00:00Z',
			'2026-11-05t12:00:00z',
			''
		]) {
			assert.deepStrictEqual(
				shape_of(SessionAccountJson, { ...SESSION_ACCOUNT, created_at: t }),
				[['iso_datetime', ['created_at'], 'iso_datetime']],
				t
			);
		}
		const bad = '2026-11-05 12:00:00+00';
		const cases: ReadonlyArray<[AnySchema, unknown, Array<string | number>]> = [
			[AdminAccountJson, { ...ADMIN_ACCOUNT, deleted_at: bad }, ['deleted_at']],
			[AuthSessionJson, { ...SESSION, expires_at: bad }, ['expires_at']],
			[AdminSessionJson, { ...ADMIN_SESSION, created_at: bad }, ['created_at']],
			[RoleGrantSummaryJson, { ...GRANT, expires_at: bad }, ['expires_at']],
			[PendingOfferSummaryJson, { ...OFFER, created_at: bad }, ['created_at']],
			[AuditLogEventJson, { ...AUDIT_EVENT, created_at: bad }, ['created_at']],
			[InviteJson, { ...INVITE, claimed_at: bad }, ['claimed_at']],
			[
				SessionListOutput,
				{ sessions: [{ ...SESSION, created_at: bad }] },
				['sessions', 0, 'created_at']
			],
			[
				AdminAccountEntryJson,
				{ ...ENTRY, role_grants: [GRANT, { ...GRANT, created_at: bad }] },
				['role_grants', 1, 'created_at']
			]
		];
		for (const [schema, input, path] of cases) {
			assert.deepStrictEqual(shape_of(schema, input), [['iso_datetime', path, 'iso_datetime']]);
		}
	});

	test('an account or invite username is canonical', () => {
		const expected = String(USERNAME_CANONICAL_REGEX);
		for (const username of ['alice', 'ab1', 'a-b_c', 'a'.repeat(USERNAME_LENGTH_MAX)]) {
			assert.isNull(issues_of(SessionAccountJson, { ...SESSION_ACCOUNT, username }), username);
		}
		for (const username of ['AliCe', 'ALICE', 'Ab1', '1ab', 'ab-', 'al ice']) {
			assert.deepStrictEqual(
				shape_of(SessionAccountJson, { ...SESSION_ACCOUNT, username }),
				[['regex', ['username'], expected]],
				username
			);
		}
		assert.deepStrictEqual(shape_of(AdminAccountJson, { ...ADMIN_ACCOUNT, username: 'Bob' }), [
			['regex', ['username'], expected]
		]);
		assert.deepStrictEqual(shape_of(InviteJson, { ...INVITE, username: 'Bob' }), [
			['regex', ['username'], expected]
		]);
		assert.deepStrictEqual(
			shape_of(AdminAccountListOutput, {
				accounts: [{ ...ENTRY, account: { ...ADMIN_ACCOUNT, username: 'Bob' } }],
				grantable_roles: []
			}),
			[['regex', ['accounts', 0, 'account', 'username'], expected]]
		);
	});

	test('a grant or offer holds strict names', () => {
		const regex = String(NAME_REGEX);
		for (const role of ['admin', 'teacher', 'a'.repeat(NAME_LENGTH_MAX)]) {
			assert.isNull(issues_of(RoleGrantSummaryJson, { ...GRANT, role }), role);
			assert.isNull(issues_of(PendingOfferSummaryJson, { ...OFFER, scope_kind: role }), role);
		}
		for (const name of ['Admin', 'team-lead', '']) {
			assert.deepStrictEqual(shape_of(RoleGrantSummaryJson, { ...GRANT, role: name }), [
				['regex', ['role'], regex]
			]);
			assert.deepStrictEqual(shape_of(RoleGrantSummaryJson, { ...GRANT, scope_kind: name }), [
				['regex', ['scope_kind'], regex]
			]);
			assert.deepStrictEqual(shape_of(PendingOfferSummaryJson, { ...OFFER, role: name }), [
				['regex', ['role'], regex]
			]);
			assert.deepStrictEqual(shape_of(PendingOfferSummaryJson, { ...OFFER, scope_kind: name }), [
				['regex', ['scope_kind'], regex]
			]);
		}
		assert.deepStrictEqual(
			shape_of(RoleGrantSummaryJson, { ...GRANT, role: 'a'.repeat(NAME_LENGTH_MAX + 1) }),
			[['max_length', ['role'], `length <= ${NAME_LENGTH_MAX}`]]
		);
		assert.deepStrictEqual(
			shape_of(AdminAccountListOutput, { accounts: [], grantable_roles: ['Admin'] }),
			[['regex', ['grantable_roles', 0], regex]]
		);
	});

	test('one length issue: a username or event_type out of bounds and off the grammar', () => {
		for (const [schema, base] of USERNAME_HOLDERS) {
			assert.deepStrictEqual(shape_of(schema, { ...base, username: 'a' }), [
				['min_length', ['username'], 'length >= 3']
			]);
			assert.deepStrictEqual(
				shape_of(schema, { ...base, username: '1'.repeat(USERNAME_LENGTH_MAX + 1) }),
				[['max_length', ['username'], `length <= ${USERNAME_LENGTH_MAX}`]]
			);
		}
		assert.deepStrictEqual(
			issues_of(AuditLogEventJson, {
				...AUDIT_EVENT,
				event_type: '1'.repeat(NAME_LENGTH_MAX + 1)
			})?.map((i) => [i.kind, i.message]),
			[['max_length', `event_type: ${AUDIT_EVENT_TYPE_NAME_LENGTH_MESSAGE}`]]
		);
	});

	test('the array username gets the type issue alone', () => {
		for (const username of [[], ['a', 'b', 'c']]) {
			assert.deepStrictEqual(shape_of(SessionAccountJson, { ...SESSION_ACCOUNT, username }), [
				['string', ['username'], 'string']
			]);
			assert.deepStrictEqual(shape_of(InviteJson, { ...INVITE, username }), [
				['string', ['username'], 'string']
			]);
		}
	});

	test('the email bound: code units, then the grammar, then the bytes', () => {
		assert.isNull(issues_of(SessionAccountJson, { ...SESSION_ACCOUNT, email: 'User@Example.com' }));
		for (const [schema, base] of USERNAME_HOLDERS) {
			assert.deepStrictEqual(
				issues_of(schema, { ...base, email: 'a'.repeat(EMAIL_LENGTH_MAX + 1) }),
				[
					{
						kind: 'max_length',
						path: ['email'],
						expected: `length <= ${EMAIL_LENGTH_MAX}`,
						received: 'string',
						message: `email: ${EMAIL_LENGTH_MESSAGE}`
					}
				]
			);
			assert.deepStrictEqual(shape_of(schema, { ...base, email: 'ü'.repeat(130) }), [
				['regex', ['email'], String(EMAIL_REGEX)]
			]);
			assert.deepStrictEqual(
				issues_of(schema, { ...base, email: `${'ü'.repeat(122)}@example.com` })?.map((i) => [
					i.kind,
					i.message
				]),
				[['check', `email: ${EMAIL_LENGTH_MESSAGE}`]]
			);
		}
	});

	test('a seq that is no safe integer gets one safe_integer issue', () => {
		for (const seq of [0, 1, -1, Number.MAX_SAFE_INTEGER]) {
			assert.isNull(issues_of(AuditLogEventJson, { ...AUDIT_EVENT, seq }), String(seq));
		}
		for (const seq of [1.5, Number.MAX_SAFE_INTEGER + 1, 1e300]) {
			assert.deepStrictEqual(
				shape_of(AuditLogEventJson, { ...AUDIT_EVENT, seq }),
				[['safe_integer', ['seq'], 'safe_integer']],
				String(seq)
			);
		}
		assert.deepStrictEqual(shape_of(AuditLogEventJson, { ...AUDIT_EVENT, seq: NaN }), [
			['number', ['seq'], 'number']
		]);
	});
});
