/**
 * The row schemas of the account, session, audit and invite outputs,
 * `@fuzdev/fuz_schema` schemas, held to the Zod schemas they replaced,
 * rebuilt here: `SessionAccountJson`, `AuthSessionJson`,
 * `RoleGrantSummaryJson`, `ActorSummaryJson`, `AdminAccountJson`,
 * `PendingOfferSummaryJson`, `AdminAccountEntryJson`, `AdminSessionJson`,
 * `AuditLogEventJson`, `AuditLogEventWithUsernamesJson`,
 * `RoleGrantHistoryEventJson`, `InviteJson` and `InviteWithUsernamesJson`,
 * the outputs, input and SSE params that hold them, and `SessionId`. On corpora of single changes to a valid
 * value, each pair gives the same verdict and output, and the same wire
 * issues but for `message`, which is the Zod text, behind the issue's path,
 * wherever Zod's was a custom one.
 *
 * Declared differences, each recognized where it is allowed and counted:
 *
 * - **the strict timestamp**: a timestamp is `Timestamp`, fuz_schema's
 *   `iso_datetime` (Zod: any string), so a row holding one that is no date
 *   and time of RFC 3339 in UTC fails. Both spines write
 *   `YYYY-MM-DDTHH:MM:SSZ`.
 * - **the canonical username**: an account's or an invite's `username` is
 *   `UsernameCanonical` (Zod: the creation `Username`, which lowercased), so
 *   a username with an uppercase letter fails, where Zod gave its lowercase.
 *   Both spines store every username lowercase, which the
 *   `account_username_lowercase` CHECK holds. A username off both grammars
 *   gets the canonical grammar's `regex` issue, its `expected` the lowercase
 *   pattern.
 * - **the strict names**: a grant's or an offer's `role` is a `RoleName` and
 *   its `scope_kind` a `ScopeKindName` or `null` (Zod: any string), so a row
 *   holding one off the grammar fails.
 * - **one length issue**, **the array username** and **the email bound**, as
 *   in `admin_action_specs.differential.test.ts`: a `username` outside its
 *   bounds and off the grammar, or an array, gets one issue, and so does an
 *   `event_type` too long and off its grammar; an `email` past
 *   `EMAIL_LENGTH_MAX` code units gets a `max_length` issue, and one within
 *   them, past the bytes and off the grammar, the grammar issue.
 * - **the safe-integer issue**: a `seq` that is a finite number but no safe
 *   integer gets a `safe_integer` issue, where Zod's `.int()` gives an
 *   `integer` issue for a fraction and a `max_value` one past the safe range.
 *   Both refuse it.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';
import { is_schema } from '@fuzdev/fuz_schema/schema.ts';

import {
	EMAIL_LENGTH_MAX,
	EMAIL_LENGTH_MESSAGE,
	EMAIL_REGEX,
	Email as ZodEmail,
	USERNAME_LENGTH_MAX,
	USERNAME_REGEX,
	Username as ZodUsername,
	Uuid as ZodUuid
} from '#lib/primitive_schemas.ts';
import { Timestamp, USERNAME_CANONICAL_REGEX } from '#lib/primitive_schemas_fuz.ts';
import { RoleName as ZodRoleName } from '#lib/auth/role_schema.ts';
import { NAME_LENGTH_MAX } from '#lib/auth/name_schema.ts';
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
	AuditEventTypeName as ZodAuditEventTypeName,
	AuditLogEventJson,
	AuditLogEventWithUsernamesJson,
	AuditOutcome as ZodAuditOutcome,
	RoleGrantHistoryEventJson
} from '#lib/auth/audit_log_schema.ts';
import { AUDIT_EVENT_TYPE_NAME_LENGTH_MESSAGE } from '#lib/auth/audit_log_schema_fuz.ts';
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
import {
	parse_any,
	to_wire_issues,
	type ValidationSchema,
	type WireIssue
} from '#lib/schema_issues.ts';

// -- the Zod schemas the port replaced --------------------------------------

const BLAKE3_HASH_MESSAGE_AT_CAPTURE = 'Expected a 64-character lowercase hex blake3 hash';
const ZodSessionId = z
	.string()
	.regex(/^[0-9a-f]{64}$/, BLAKE3_HASH_MESSAGE_AT_CAPTURE)
	.brand('SessionId');
const ZodSessionAccountJson = z.strictObject({
	id: ZodUuid,
	username: ZodUsername,
	email: ZodEmail.nullable(),
	email_verified: z.boolean(),
	created_at: z.string()
});
const ZodAuthSessionJson = z.strictObject({
	id: ZodSessionId,
	account_id: ZodUuid,
	created_at: z.string(),
	expires_at: z.string(),
	is_current: z.boolean()
});
const ZodRoleGrantSummaryJson = z.strictObject({
	id: ZodUuid,
	role: z.string(),
	scope_kind: z.string().nullable(),
	scope_id: ZodUuid.nullable(),
	created_at: z.string(),
	expires_at: z.string().nullable(),
	granted_by: ZodUuid.nullable()
});
const ZodActorSummaryJson = z.strictObject({ id: ZodUuid, name: z.string() });
const ZodAdminAccountJson = ZodSessionAccountJson.extend({
	updated_at: z.string(),
	updated_by: ZodUuid.nullable(),
	deleted_at: z.string().nullable()
});
const ZodPendingOfferSummaryJson = z.strictObject({
	id: ZodUuid,
	role: z.string(),
	scope_kind: z.string().nullable(),
	scope_id: ZodUuid.nullable(),
	from_actor_id: ZodUuid,
	from_username: z.string(),
	created_at: z.string(),
	expires_at: z.string()
});
const ZodAdminAccountEntryJson = z.strictObject({
	account: ZodAdminAccountJson,
	actor: ZodActorSummaryJson.nullable(),
	role_grants: z.array(ZodRoleGrantSummaryJson),
	pending_offers: z.array(ZodPendingOfferSummaryJson)
});
const ZodAdminSessionJson = ZodAuthSessionJson.omit({ is_current: true }).extend({
	username: z.string()
});
const ZodSessionListOutput = z.strictObject({ sessions: z.array(ZodAuthSessionJson) });
const ZodSessionRevokeInput = z.strictObject({ session_id: ZodSessionId });
const ZodAccountStatusOutput = z.strictObject({
	account: ZodSessionAccountJson,
	actor: ZodActorSummaryJson.nullable(),
	role_grants: z.array(ZodRoleGrantSummaryJson)
});
const ZodAdminAccountListOutput = z.strictObject({
	accounts: z.array(ZodAdminAccountEntryJson),
	grantable_roles: z.array(ZodRoleName)
});
const ZodAdminSessionListOutput = z.strictObject({ sessions: z.array(ZodAdminSessionJson) });
const ZodAuditLogEventJson = z.strictObject({
	id: ZodUuid,
	seq: z.number().int(),
	event_type: ZodAuditEventTypeName,
	outcome: ZodAuditOutcome,
	actor_id: ZodUuid.nullable(),
	account_id: ZodUuid.nullable(),
	target_account_id: ZodUuid.nullable(),
	target_actor_id: ZodUuid.nullable(),
	ip: z.string().nullable(),
	created_at: z.string(),
	metadata: z.record(z.string(), z.unknown()).nullable()
});
const ZodAuditLogEventWithUsernamesJson = ZodAuditLogEventJson.extend({
	username: z.string().nullable(),
	target_username: z.string().nullable()
});
const ZodInviteJson = z.strictObject({
	id: ZodUuid,
	email: ZodEmail.nullable(),
	username: ZodUsername.nullable(),
	claimed_by: ZodUuid.nullable(),
	claimed_at: z.string().nullable(),
	created_at: z.string(),
	created_by: ZodUuid.nullable()
});
const ZodInviteWithUsernamesJson = ZodInviteJson.extend({
	created_by_username: z.string().nullable(),
	claimed_by_username: z.string().nullable()
});
const ZodInviteCreateOutput = z.strictObject({ ok: z.literal(true), invite: ZodInviteJson });
const ZodInviteListOutput = z.strictObject({ invites: z.array(ZodInviteWithUsernamesJson) });
const ZodAuditLogListOutput = z.strictObject({
	events: z.array(ZodAuditLogEventWithUsernamesJson)
});

// -- corpora ----------------------------------------------------------------

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const NOW = '2026-11-05T12:00:00Z';
const HASH = 'a'.repeat(64);
const ASTRAL = '\u{1F600}';

const UUIDS: ReadonlyArray<unknown> = [ID, ID.toUpperCase(), 'not-a-uuid', '', 1];
const BOOLEANS: ReadonlyArray<unknown> = [true, false, 'true', 1];
const STRINGS: ReadonlyArray<unknown> = ['x', '', 'Some Name', 1, null];
const TIMESTAMPS: ReadonlyArray<unknown> = [
	NOW,
	'2026-11-05T12:00:00.123Z',
	'2026-11-05T12:00:00.123456789Z',
	'2024-02-29T23:59:59Z',
	'2026-11-05T12:00:00+00:00',
	'2026-11-05 12:00:00+00',
	'2026-11-05T12:00Z',
	'2026-02-30T00:00:00Z',
	'2026-11-05t12:00:00z',
	'',
	'x',
	1,
	null
];
const USERNAMES: ReadonlyArray<unknown> = [
	'alice',
	'a1',
	'abc',
	'a-b_c',
	'a'.repeat(USERNAME_LENGTH_MAX),
	'AliCe',
	'ALICE',
	'Ab',
	'a'.repeat(USERNAME_LENGTH_MAX + 1),
	'1'.repeat(USERNAME_LENGTH_MAX + 1),
	'ab',
	'a',
	'',
	'1ab',
	'ab-',
	'al ice',
	ASTRAL.repeat(2),
	[],
	['a', 'b', 'c'],
	1,
	null
];
const EMAILS: ReadonlyArray<unknown> = [
	'user@example.com',
	'User@Example.com',
	'a@b.c',
	'a@.b.c',
	'user@host',
	'',
	`${'a'.repeat(EMAIL_LENGTH_MAX - 12)}@example.com`,
	'a'.repeat(EMAIL_LENGTH_MAX + 1),
	`${'ü'.repeat(122)}@example.com`,
	1,
	null
];
const ROLES: ReadonlyArray<unknown> = [
	'admin',
	'teacher',
	'a'.repeat(NAME_LENGTH_MAX),
	'Admin',
	'team-lead',
	'a'.repeat(NAME_LENGTH_MAX + 1),
	'',
	1
];
const SCOPE_KINDS: ReadonlyArray<unknown> = [...ROLES, null];
const SESSION_IDS: ReadonlyArray<unknown> = [
	HASH,
	'0'.repeat(64),
	'A'.repeat(64),
	'a'.repeat(63),
	'a'.repeat(65),
	'g'.repeat(64),
	'',
	1
];

type Fields = Record<string, ReadonlyArray<unknown>>;

const MISSING = Symbol('missing');

/**
 * Every single change to `base`: each field set to each value of its pool or
 * left out, an unknown key, and values that are no object.
 */
const corpus_of = (base: Record<string, unknown>, fields: Fields): Array<[string, unknown]> => {
	const out: Array<[string, unknown]> = [['base', base]];
	for (const [key, pool] of Object.entries(fields)) {
		for (const value of [...pool, MISSING]) {
			const changed = { ...base };
			if (value === MISSING) delete changed[key];
			else changed[key] = value;
			out.push([`${key}: ${value === MISSING ? 'missing' : String(value).slice(0, 20)}`, changed]);
		}
	}
	out.push(['unknown key', { ...base, extra: 1 }]);
	for (const value of [null, [], 'x', 1]) out.push([`not an object: ${value}`, value]);
	return out;
};

/** The corpus of `inner`, each case set at `key` of `outer`. */
const wrapped = (
	outer: (inner: unknown) => unknown,
	inner: ReadonlyArray<[string, unknown]>
): Array<[string, unknown]> => inner.map(([label, value]) => [`wrapped ${label}`, outer(value)]);

const SESSION_ACCOUNT = {
	id: ID,
	username: 'alice',
	email: 'alice@example.com',
	email_verified: false,
	created_at: NOW
};
const SESSION_ACCOUNT_FIELDS: Fields = {
	id: UUIDS,
	username: USERNAMES,
	email: EMAILS,
	email_verified: BOOLEANS,
	created_at: TIMESTAMPS
};
const ADMIN_ACCOUNT = {
	...SESSION_ACCOUNT,
	updated_at: NOW,
	updated_by: null,
	deleted_at: null
};
const ADMIN_ACCOUNT_FIELDS: Fields = {
	...SESSION_ACCOUNT_FIELDS,
	updated_at: TIMESTAMPS,
	updated_by: [...UUIDS, null],
	deleted_at: TIMESTAMPS
};
const SESSION = {
	id: HASH,
	account_id: ID,
	created_at: NOW,
	expires_at: NOW,
	is_current: true
};
const SESSION_FIELDS: Fields = {
	id: SESSION_IDS,
	account_id: UUIDS,
	created_at: TIMESTAMPS,
	expires_at: TIMESTAMPS,
	is_current: BOOLEANS
};
const ADMIN_SESSION = { id: HASH, account_id: ID, created_at: NOW, expires_at: NOW, username: 'x' };
const { is_current: _, ...ADMIN_SESSION_BASE_FIELDS } = SESSION_FIELDS;
const ADMIN_SESSION_FIELDS: Fields = { ...ADMIN_SESSION_BASE_FIELDS, username: STRINGS };
const GRANT = {
	id: ID,
	role: 'teacher',
	scope_kind: 'classroom',
	scope_id: ID2,
	created_at: NOW,
	expires_at: null,
	granted_by: null
};
const GRANT_FIELDS: Fields = {
	id: UUIDS,
	role: ROLES,
	scope_kind: SCOPE_KINDS,
	scope_id: [...UUIDS, null],
	created_at: TIMESTAMPS,
	expires_at: TIMESTAMPS,
	granted_by: [...UUIDS, null]
};
const ACTOR = { id: ID, name: 'alice' };
const ACTOR_FIELDS: Fields = { id: UUIDS, name: STRINGS };
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
const OFFER_FIELDS: Fields = {
	id: UUIDS,
	role: ROLES,
	scope_kind: SCOPE_KINDS,
	scope_id: [...UUIDS, null],
	from_actor_id: UUIDS,
	from_username: STRINGS,
	created_at: TIMESTAMPS,
	expires_at: TIMESTAMPS
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
const AUDIT_EVENT_FIELDS: Fields = {
	id: UUIDS,
	seq: [0, 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, -1, 1.5, 1e300, NaN, '1', null],
	event_type: [
		'login',
		'app.thing/created-v2',
		'a'.repeat(NAME_LENGTH_MAX),
		'a'.repeat(NAME_LENGTH_MAX + 1),
		'1'.repeat(NAME_LENGTH_MAX + 1),
		'',
		'1login',
		1
	],
	outcome: ['success', 'failure', 'Success', '', 0],
	actor_id: [...UUIDS, null],
	account_id: [...UUIDS, null],
	target_account_id: [...UUIDS, null],
	target_actor_id: [...UUIDS, null],
	ip: STRINGS,
	created_at: TIMESTAMPS,
	metadata: [null, {}, { a: 1, b: [null] }, JSON.parse('{"__proto__":{"x":1}}'), [], [1], 'x', 1]
};
const WITH_USERNAMES = { ...AUDIT_EVENT, username: 'alice', target_username: null };
const WITH_USERNAMES_FIELDS: Fields = {
	...AUDIT_EVENT_FIELDS,
	username: STRINGS,
	target_username: STRINGS
};
const INVITE = {
	id: ID,
	email: 'bob@example.com',
	username: 'bob',
	claimed_by: null,
	claimed_at: null,
	created_at: NOW,
	created_by: ID2
};
const INVITE_FIELDS: Fields = {
	id: UUIDS,
	email: EMAILS,
	username: USERNAMES,
	claimed_by: [...UUIDS, null],
	claimed_at: TIMESTAMPS,
	created_at: TIMESTAMPS,
	created_by: [...UUIDS, null]
};
const INVITE_WITH_USERNAMES = {
	...INVITE,
	created_by_username: 'alice',
	claimed_by_username: null
};
const INVITE_WITH_USERNAMES_FIELDS: Fields = {
	...INVITE_FIELDS,
	created_by_username: STRINGS,
	claimed_by_username: STRINGS
};

const ENTRY = {
	account: ADMIN_ACCOUNT,
	actor: ACTOR,
	role_grants: [GRANT],
	pending_offers: [OFFER]
};

/** Every single change to an entry: to its account, its actor, a grant, an offer, or a field. */
const entry_corpus = (): Array<[string, unknown]> => [
	...corpus_of(ENTRY, {
		actor: [null, 'x'],
		role_grants: [[], [GRANT, GRANT], null],
		pending_offers: [[], null]
	}),
	...wrapped((v) => ({ ...ENTRY, account: v }), corpus_of(ADMIN_ACCOUNT, ADMIN_ACCOUNT_FIELDS)),
	...wrapped((v) => ({ ...ENTRY, actor: v }), corpus_of(ACTOR, ACTOR_FIELDS)),
	...wrapped((v) => ({ ...ENTRY, role_grants: [GRANT, v] }), corpus_of(GRANT, GRANT_FIELDS)),
	...wrapped((v) => ({ ...ENTRY, pending_offers: [v] }), corpus_of(OFFER, OFFER_FIELDS))
];

// -- the comparison ---------------------------------------------------------

type Outcome = { ok: true; value: unknown } | { ok: false; issues: Array<WireIssue> };

const outcome_of = (schema: ValidationSchema, input: unknown): Outcome => {
	const result = parse_any(schema, input);
	return result.ok
		? { ok: true, value: result.value }
		: { ok: false, issues: to_wire_issues(result.issues, input) };
};

const without_message = ({ message: _, ...rest }: WireIssue): Omit<WireIssue, 'message'> => rest;

const same_path = (a: WireIssue | undefined, b: WireIssue): boolean =>
	a !== undefined && JSON.stringify(a.path) === JSON.stringify(b.path);

/** The value at `path` in `input`. */
const at_path = (input: unknown, path: ReadonlyArray<unknown>): unknown =>
	path.reduce<unknown>(
		(v, key) => (v as Record<PropertyKey, unknown>)?.[key as PropertyKey],
		input
	);

const off_name_grammar = (value: unknown): boolean =>
	typeof value === 'string' && !parse_any(ZodRoleName, value).ok;

/** The custom messages Zod's issues carry, which the fuz_schema issues keep behind their path. */
const CUSTOM_MESSAGES: ReadonlyArray<string> = [
	EMAIL_LENGTH_MESSAGE,
	BLAKE3_HASH_MESSAGE_AT_CAPTURE,
	AUDIT_EVENT_TYPE_NAME_LENGTH_MESSAGE
];

interface Counts {
	matched: number;
	refused: number;
	strict_timestamp: number;
	canonical_username: number;
	strict_name: number;
	one_length_issue: number;
	array_username: number;
	email_bound: number;
	one_safe_integer_issue: number;
	custom_message: number;
}

/**
 * The declared difference a refusal Zod didn't make is, by its one issue, or
 * `null` for none.
 */
const strict_kind_of = (
	issue: WireIssue,
	value: unknown
): 'strict_timestamp' | 'canonical_username' | 'strict_name' | null => {
	const key = String(issue.path.at(-1));
	if (issue.kind === 'iso_datetime' && key.endsWith('_at')) {
		return typeof value === 'string' && !parse_any(Timestamp, value).ok ? 'strict_timestamp' : null;
	}
	if (key === 'username' && issue.kind === 'regex') {
		return typeof value === 'string' &&
			USERNAME_REGEX.test(value) &&
			!USERNAME_CANONICAL_REGEX.test(value)
			? 'canonical_username'
			: null;
	}
	if ((key === 'role' || key === 'scope_kind') && ['max_length', 'regex'].includes(issue.kind)) {
		return off_name_grammar(value) ? 'strict_name' : null;
	}
	return null;
};

const run = (
	schema: ValidationSchema,
	zod_schema: ValidationSchema,
	corpus: ReadonlyArray<[string, unknown]>
): Counts => {
	const counts: Counts = {
		matched: 0,
		refused: 0,
		strict_timestamp: 0,
		canonical_username: 0,
		strict_name: 0,
		one_length_issue: 0,
		array_username: 0,
		email_bound: 0,
		one_safe_integer_issue: 0,
		custom_message: 0
	};
	for (const [label, input] of corpus) {
		const fuz = outcome_of(schema, input);
		const zod = outcome_of(zod_schema, input);
		if (fuz.ok && zod.ok) {
			counts.matched++;
			assert.deepStrictEqual(fuz.value, zod.value, label);
			continue;
		}
		if (!fuz.ok && zod.ok) {
			assert.strictEqual(fuz.issues.length, 1, label);
			const issue = fuz.issues[0]!;
			const kind = strict_kind_of(issue, at_path(input, issue.path));
			assert.ok(kind, `${label}: fuz refused what Zod took: ${JSON.stringify(issue)}`);
			counts[kind]++;
			continue;
		}
		assert.ok(!fuz.ok && !zod.ok, `${label}: fuz took what Zod refused`);
		counts.refused++;
		let zod_issues = zod.issues;
		// declared: one length issue where Zod gives the length and the grammar
		zod_issues = zod_issues.filter((issue, i) => {
			const prev = zod_issues[i - 1];
			const dropped =
				issue.kind === 'regex' &&
				(issue.path.at(-1) === 'username' || issue.path.at(-1) === 'event_type') &&
				(prev?.kind === 'max_length' || prev?.kind === 'min_length') &&
				same_path(prev, issue);
			if (dropped) counts.one_length_issue++;
			return !dropped;
		});
		// declared: the canonical username, the lowercase grammar's issue
		zod_issues = zod_issues.map((issue) =>
			issue.kind === 'regex' && issue.path.at(-1) === 'username'
				? { ...issue, expected: String(USERNAME_CANONICAL_REGEX) }
				: issue
		);
		// declared: the email bound
		zod_issues = zod_issues.flatMap((issue) => {
			const value = at_path(input, issue.path);
			const bound_check =
				issue.path.at(-1) === 'email' &&
				typeof value === 'string' &&
				issue.kind === 'check' &&
				issue.message === EMAIL_LENGTH_MESSAGE;
			if (!bound_check) return [issue];
			if (value.length > EMAIL_LENGTH_MAX) {
				counts.email_bound++;
				return [{ ...issue, kind: 'max_length', expected: `length <= ${EMAIL_LENGTH_MAX}` }];
			}
			if (EMAIL_REGEX.test(value)) return [issue];
			counts.email_bound++;
			return [{ ...issue, kind: 'regex', expected: String(EMAIL_REGEX), message: '' }];
		});
		// declared: the type issue alone for a `username` that is an array
		zod_issues = zod_issues.filter((issue, i) => {
			const prev = zod_issues[i - 1];
			const dropped =
				(issue.kind === 'min_length' || issue.kind === 'max_length') &&
				issue.path.at(-1) === 'username' &&
				Array.isArray(at_path(input, issue.path)) &&
				prev?.kind === 'string' &&
				same_path(prev, issue);
			if (dropped) counts.array_username++;
			return !dropped;
		});
		// declared: one safe-integer issue where Zod gives `.int()`'s
		zod_issues = zod_issues.flatMap((issue, i) => {
			if (issue.path.at(-1) !== 'seq') return [issue];
			const prev = zod_issues[i - 1];
			if (prev !== undefined && same_path(prev, issue)) return [];
			const value = at_path(input, issue.path);
			if (typeof value !== 'number' || Number.isNaN(value) || Number.isSafeInteger(value)) {
				return [issue];
			}
			counts.one_safe_integer_issue++;
			return [{ ...issue, kind: 'safe_integer', expected: 'safe_integer' }];
		});
		// a field Zod took and fuz refused, beside one both refused
		const fuz_issues = fuz.issues.filter((issue) => {
			const kind = strict_kind_of(issue, at_path(input, issue.path));
			if (kind === null || zod_issues.some((z_issue) => same_path(z_issue, issue))) return true;
			counts[kind]++;
			return false;
		});
		assert.deepStrictEqual(fuz_issues.map(without_message), zod_issues.map(without_message), label);
		// a custom Zod message is kept, behind the issue's path
		for (const [i, issue] of zod_issues.entries()) {
			if (!CUSTOM_MESSAGES.includes(issue.message)) continue;
			counts.custom_message++;
			const at = issue.path.length === 0 ? '' : `${issue.path.join('.')}: `;
			assert.strictEqual(fuz_issues[i]!.message, `${at}${issue.message}`, label);
		}
	}
	return counts;
};

const at_least = (counts: Counts, floors: Partial<Counts>): void => {
	for (const [key, floor] of Object.entries(floors)) {
		assert.ok(counts[key as keyof Counts] >= floor, `${key}: ${JSON.stringify(counts)}`);
	}
};

describe('the row schemas agree with the Zod ones', () => {
	test('are fuz_schema schemas', () => {
		for (const schema of [
			SessionId,
			SessionAccountJson,
			AuthSessionJson,
			RoleGrantSummaryJson,
			ActorSummaryJson,
			AdminAccountJson,
			PendingOfferSummaryJson,
			AdminAccountEntryJson,
			AdminSessionJson,
			SessionListOutput,
			SessionRevokeInput,
			AccountStatusOutput,
			AdminAccountListOutput,
			AdminSessionListOutput,
			AuditLogEventJson,
			AuditLogEventWithUsernamesJson,
			RoleGrantHistoryEventJson,
			AuditLogListOutput,
			AuditLogRoleGrantHistoryOutput,
			InviteJson,
			InviteWithUsernamesJson,
			InviteCreateOutput,
			InviteListOutput
		]) {
			assert.ok(is_schema(schema));
		}
		assert.strictEqual(account_verify_action_spec.output, SessionAccountJson);
	});

	test('SessionAccountJson, but for the strict timestamp, the canonical username and the email', () => {
		const counts = run(
			SessionAccountJson,
			ZodSessionAccountJson,
			corpus_of(SESSION_ACCOUNT, SESSION_ACCOUNT_FIELDS)
		);
		at_least(counts, {
			matched: 15,
			refused: 30,
			strict_timestamp: 7,
			canonical_username: 2,
			one_length_issue: 2,
			array_username: 1,
			email_bound: 1,
			custom_message: 2
		});
	});

	test('AdminAccountJson, as SessionAccountJson with its audit fields', () => {
		const counts = run(
			AdminAccountJson,
			ZodAdminAccountJson,
			corpus_of(ADMIN_ACCOUNT, ADMIN_ACCOUNT_FIELDS)
		);
		at_least(counts, { matched: 25, refused: 40, strict_timestamp: 21, canonical_username: 2 });
	});

	test('the sessions and SessionId, its message kept', () => {
		const session = run(AuthSessionJson, ZodAuthSessionJson, corpus_of(SESSION, SESSION_FIELDS));
		at_least(session, { matched: 10, refused: 15, strict_timestamp: 14, custom_message: 4 });
		const admin = run(
			AdminSessionJson,
			ZodAdminSessionJson,
			corpus_of(ADMIN_SESSION, ADMIN_SESSION_FIELDS)
		);
		at_least(admin, { matched: 10, refused: 15, strict_timestamp: 14, custom_message: 4 });
		const id = run(
			SessionId,
			ZodSessionId,
			SESSION_IDS.map((v): [string, unknown] => [String(v), v])
		);
		at_least(id, { matched: 2, refused: 6 });
		const revoke = run(
			SessionRevokeInput,
			ZodSessionRevokeInput,
			corpus_of({ session_id: HASH }, { session_id: SESSION_IDS })
		);
		at_least(revoke, { matched: 2, refused: 10, custom_message: 4 });
		const list = run(SessionListOutput, ZodSessionListOutput, [
			...wrapped((v) => ({ sessions: [SESSION, v] }), corpus_of(SESSION, SESSION_FIELDS)),
			...corpus_of({ sessions: [] }, { sessions: [null, {}, [null]] })
		]);
		at_least(list, { matched: 10, refused: 15, strict_timestamp: 14 });
		const admin_list = run(AdminSessionListOutput, ZodAdminSessionListOutput, [
			...wrapped((v) => ({ sessions: [v] }), corpus_of(ADMIN_SESSION, ADMIN_SESSION_FIELDS)),
			...corpus_of({ sessions: [] }, { sessions: [null, {}, [null]] })
		]);
		at_least(admin_list, { matched: 10, refused: 15, strict_timestamp: 14 });
	});

	test('the grant, actor and offer summaries, but for the strict names and timestamps', () => {
		const grant = run(
			RoleGrantSummaryJson,
			ZodRoleGrantSummaryJson,
			corpus_of(GRANT, GRANT_FIELDS)
		);
		at_least(grant, { matched: 15, refused: 25, strict_timestamp: 14, strict_name: 8 });
		const actor = run(ActorSummaryJson, ZodActorSummaryJson, corpus_of(ACTOR, ACTOR_FIELDS));
		at_least(actor, { matched: 5, refused: 8 });
		const offer = run(
			PendingOfferSummaryJson,
			ZodPendingOfferSummaryJson,
			corpus_of(OFFER, OFFER_FIELDS)
		);
		at_least(offer, { matched: 15, refused: 25, strict_timestamp: 14, strict_name: 8 });
	});

	test('the admin account entry and listing, and the account status', () => {
		const entry = run(AdminAccountEntryJson, ZodAdminAccountEntryJson, entry_corpus());
		at_least(entry, {
			matched: 50,
			refused: 80,
			strict_timestamp: 45,
			strict_name: 16,
			canonical_username: 2
		});
		const listing = run(AdminAccountListOutput, ZodAdminAccountListOutput, [
			...wrapped((v) => ({ accounts: [v], grantable_roles: ['admin'] }), entry_corpus()),
			...corpus_of(
				{ accounts: [], grantable_roles: ['admin'] },
				{ grantable_roles: [[], ['Admin'], ['a'.repeat(NAME_LENGTH_MAX + 1)], null] }
			)
		]);
		at_least(listing, { matched: 50, refused: 80, strict_timestamp: 45, canonical_username: 2 });
		const status = run(AccountStatusOutput, ZodAccountStatusOutput, [
			...corpus_of(
				{ account: SESSION_ACCOUNT, actor: ACTOR, role_grants: [GRANT] },
				{ actor: [null, 'x'], role_grants: [[], null] }
			),
			...wrapped(
				(v) => ({ account: v, actor: ACTOR, role_grants: [] }),
				corpus_of(SESSION_ACCOUNT, SESSION_ACCOUNT_FIELDS)
			),
			...wrapped(
				(v) => ({ account: SESSION_ACCOUNT, actor: null, role_grants: [v] }),
				corpus_of(GRANT, GRANT_FIELDS)
			)
		]);
		at_least(status, {
			matched: 30,
			refused: 50,
			strict_timestamp: 21,
			canonical_username: 2,
			strict_name: 8
		});
	});

	test('the audit rows, but for the strict timestamp and one issue', () => {
		const event = run(
			AuditLogEventJson,
			ZodAuditLogEventJson,
			corpus_of(AUDIT_EVENT, AUDIT_EVENT_FIELDS)
		);
		at_least(event, {
			matched: 30,
			refused: 50,
			strict_timestamp: 7,
			one_length_issue: 1,
			one_safe_integer_issue: 2,
			custom_message: 2
		});
		for (const schema of [AuditLogEventWithUsernamesJson, RoleGrantHistoryEventJson]) {
			const counts = run(
				schema,
				ZodAuditLogEventWithUsernamesJson,
				corpus_of(WITH_USERNAMES, WITH_USERNAMES_FIELDS)
			);
			at_least(counts, { matched: 35, refused: 55, strict_timestamp: 7 });
		}
		for (const schema of [AuditLogListOutput, AuditLogRoleGrantHistoryOutput]) {
			const counts = run(schema, ZodAuditLogListOutput, [
				...wrapped((v) => ({ events: [v] }), corpus_of(WITH_USERNAMES, WITH_USERNAMES_FIELDS)),
				...corpus_of({ events: [] }, { events: [null, {}, [null]] })
			]);
			at_least(counts, { matched: 35, refused: 55, strict_timestamp: 7 });
		}
		// every audit SSE event's params are the row
		for (const spec of audit_log_event_specs) {
			assert.strictEqual(spec.params, AuditLogEventJson, spec.method);
		}
	});

	test('the invites, but for the strict timestamp, the canonical username and the email', () => {
		const invite = run(InviteJson, ZodInviteJson, corpus_of(INVITE, INVITE_FIELDS));
		at_least(invite, {
			matched: 20,
			refused: 35,
			strict_timestamp: 14,
			canonical_username: 2,
			one_length_issue: 2,
			array_username: 1,
			email_bound: 1
		});
		const with_usernames = run(
			InviteWithUsernamesJson,
			ZodInviteWithUsernamesJson,
			corpus_of(INVITE_WITH_USERNAMES, INVITE_WITH_USERNAMES_FIELDS)
		);
		at_least(with_usernames, {
			matched: 25,
			refused: 40,
			strict_timestamp: 14,
			canonical_username: 2
		});
		const create = run(InviteCreateOutput, ZodInviteCreateOutput, [
			...wrapped((v) => ({ ok: true, invite: v }), corpus_of(INVITE, INVITE_FIELDS)),
			...corpus_of({ ok: true, invite: INVITE }, { ok: [false, 1], invite: [null, {}] })
		]);
		at_least(create, { matched: 20, refused: 40, strict_timestamp: 14, canonical_username: 2 });
		const list = run(InviteListOutput, ZodInviteListOutput, [
			...wrapped(
				(v) => ({ invites: [v] }),
				corpus_of(INVITE_WITH_USERNAMES, INVITE_WITH_USERNAMES_FIELDS)
			),
			...corpus_of({ invites: [] }, { invites: [null, {}, [null]] })
		]);
		at_least(list, { matched: 25, refused: 40, strict_timestamp: 14, canonical_username: 2 });
	});

	test('a username in another case fails, where Zod gave its lowercase', () => {
		for (const username of ['AliCe', 'ALICE', 'Ab1']) {
			const zod = ZodSessionAccountJson.safeParse({ ...SESSION_ACCOUNT, username });
			assert.ok(zod.success);
			assert.strictEqual(zod.data.username, username.toLowerCase());
			const fuz = outcome_of(SessionAccountJson, { ...SESSION_ACCOUNT, username });
			assert.ok(!fuz.ok);
			assert.deepStrictEqual(
				fuz.issues.map((i) => [i.kind, i.path, i.expected]),
				[['regex', ['username'], String(USERNAME_CANONICAL_REGEX)]]
			);
		}
	});
});
