/**
 * The admin domain's `@fuzdev/fuz_schema` schemas, held to the Zod schemas
 * they replaced, rebuilt here: every input of `all_admin_action_specs`, the
 * row-free outputs, and the app settings schemas. On corpora of single
 * changes to a valid value, each pair gives the same verdict and output, and
 * the same wire issues but for `message`, which is the Zod text, behind the
 * issue's path, wherever Zod's was a custom one. The outputs that hold a row
 * are held to theirs in `row_schemas.differential.test.ts`.
 *
 * The Zod schemas here are built over the current `Email`, whose grammar
 * refuses a domain with a dot at its edge on both libraries.
 *
 * Declared differences, each recognized where it is allowed and counted:
 *
 * - **the trailing check**: Zod still runs `invite_create`'s at-least-one
 *   refine after a field failure that doesn't abort (a UUID format, an
 *   unknown key), adding a `check` issue at `email`; the `check_at` that ends
 *   the fuz_schema `pipe` runs only on an input whose fields passed.
 * - **one length issue**: a `username` outside its bounds and off the grammar,
 *   or an `event_type` too long and off it, gets the length issue alone,
 *   where Zod adds the grammar issue.
 * - **the email bound**: Zod's byte `check` runs first and aborts, where the
 *   fuz_schema `Email` bounds the code units ahead of the grammar and the
 *   bytes after it. So an `email` past `EMAIL_LENGTH_MAX` code units gets one
 *   `max_length` issue, where Zod gives its byte `check`, with the same
 *   message, and one within the code units, past the bytes and off the
 *   grammar gets the grammar issue, where Zod gives its byte `check`.
 * - **the array username**: a `username` that is no string but has a
 *   `length` (an array) gets the type issue alone, where Zod adds a length
 *   issue when the length is outside the bounds.
 * - **one bound issue**: a `limit` past `Number.MAX_SAFE_INTEGER` gets the
 *   `max_value` issue of its bound alone, where Zod's `.int()` adds the
 *   safe-range `max_value` issue before it. The reason is the same.
 * - **the count**: the revoke-all outputs' `count` is a non-negative integer,
 *   where Zod took any number. Both spines send the number of rows deleted.
 *
 * The defaulted inputs read an omitted input as a fresh `{}` in both.
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
import { ActingActor as ZodActingActor } from '#lib/http/auth_shape.ts';
import {
	AuditEventTypeName as ZodAuditEventTypeName,
	AuditOutcome as ZodAuditOutcome
} from '#lib/auth/audit_log_schema.ts';
import {
	AUDIT_EVENT_TYPE_NAME_LENGTH_MESSAGE,
	AUDIT_EVENT_TYPE_NAME_PATTERN_MESSAGE,
	AUDIT_EVENT_TYPE_NAME_REGEX
} from '#lib/auth/audit_log_schema_fuz.ts';
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
import {
	parse_any,
	to_wire_issues,
	type ValidationSchema,
	type WireIssue
} from '#lib/schema_issues.ts';
import { NAME_LENGTH_MAX } from '#lib/auth/name_schema.ts';

// -- the Zod schemas the port replaced --------------------------------------

const zod_limit = (max: number) => z.number().int().min(1).max(max).nullish();
const zod_count = z.number().int().min(0).nullish();
const ZodActingInput = z.strictObject({ acting: ZodActingActor }).default({});

const ZodAccountListInput = z
	.strictObject({
		acting: ZodActingActor,
		limit: zod_limit(ADMIN_ACCOUNT_LIST_LIMIT_MAX),
		offset: zod_count,
		include_deleted: z.boolean().nullish()
	})
	.default({});
const ZodAccountIdInput = z.strictObject({ account_id: ZodUuid, acting: ZodActingActor });
const ZodRevokeAllOutput = z.strictObject({ ok: z.literal(true), count: z.number() });
const ZodAuditLogListInput = z
	.strictObject({
		event_type: ZodAuditEventTypeName.nullish(),
		outcome: ZodAuditOutcome.nullish(),
		account_id: ZodUuid.nullish(),
		limit: zod_limit(AUDIT_LOG_LIST_LIMIT_MAX),
		offset: zod_count,
		since_seq: zod_count,
		acting: ZodActingActor
	})
	.default({});
const ZodRoleGrantHistoryInput = z
	.strictObject({
		limit: zod_limit(AUDIT_LOG_LIST_LIMIT_MAX),
		offset: zod_count,
		acting: ZodActingActor
	})
	.default({});
const ZodInviteCreateInput = z
	.strictObject({
		email: ZodEmail.nullish(),
		username: ZodUsername.nullish(),
		acting: ZodActingActor
	})
	.refine((v) => v.email != null || v.username != null, {
		message: INVITE_TARGET_REQUIRED_MESSAGE,
		path: ['email']
	});
const ZodInviteDeleteInput = z.strictObject({ invite_id: ZodUuid, acting: ZodActingActor });
const ZodOkOutput = z.strictObject({ ok: z.literal(true) });
const ZodAppSettingsJson = z.strictObject({
	open_signup: z.boolean(),
	updated_at: z.string().nullable(),
	updated_by: ZodUuid.nullable()
});
const ZodAppSettingsWithUsernameJson = ZodAppSettingsJson.extend({
	updated_by_username: z.string().nullable()
});
const ZodAppSettingsGetOutput = z.strictObject({ settings: ZodAppSettingsWithUsernameJson });
const ZodAppSettingsUpdateInput = z.strictObject({
	open_signup: z.boolean(),
	acting: ZodActingActor
});
const ZodAppSettingsUpdateOutput = z.strictObject({
	ok: z.literal(true),
	settings: ZodAppSettingsWithUsernameJson
});
const ZodAccountDeleteInput = z
	.strictObject({ account_id: ZodUuid.nullish(), acting: ZodActingActor })
	.default({});
const ZodAccountDeleteOutput = z.strictObject({ ok: z.literal(true), deleted: z.boolean() });
const ZodAccountPurgeInput = z.strictObject({
	account_id: ZodUuid,
	confirm: z.boolean().optional(),
	acting: ZodActingActor
});
const ZodAccountPurgeOutput = z.strictObject({ ok: z.literal(true), purged: z.boolean() });
const ZodAccountUndeleteOutput = z.strictObject({ ok: z.literal(true), undeleted: z.boolean() });

// -- corpora ----------------------------------------------------------------

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const NOW = '2026-11-05T12:00:00.000Z';
const ASTRAL = '\u{1F600}';

const UUIDS: ReadonlyArray<unknown> = [
	ID,
	ID.toUpperCase(),
	'00000000-0000-0000-0000-000000000000',
	'ffffffff-ffff-ffff-ffff-ffffffffffff',
	'not-a-uuid',
	'',
	1,
	true
];
const NULLISH: ReadonlyArray<unknown> = [null, undefined];
const BOOLEANS: ReadonlyArray<unknown> = [true, false, 'true', 1, 0];
const limits = (max: number): ReadonlyArray<unknown> => [
	1,
	max,
	0,
	-1,
	max + 1,
	1.5,
	Number.MAX_SAFE_INTEGER + 1,
	1e308,
	'1',
	NaN,
	Infinity,
	true
];
const COUNTS: ReadonlyArray<unknown> = [
	0,
	1,
	Number.MAX_SAFE_INTEGER,
	Number.MAX_SAFE_INTEGER + 1,
	2 ** 53 + 2,
	1e16,
	-1,
	-0,
	0.5,
	'0',
	-Infinity,
	Infinity
];
const EMAILS: ReadonlyArray<unknown> = [
	'user@example.com',
	'User@Example.com',
	'a@b.c',
	'a@b..c',
	'a@.b.c',
	'a@b.c.',
	'user@host',
	'not-an-email',
	'',
	' user@example.com',
	`${'a'.repeat(EMAIL_LENGTH_MAX - 12)}@example.com`,
	`${'a'.repeat(EMAIL_LENGTH_MAX - 11)}@example.com`,
	'a'.repeat(EMAIL_LENGTH_MAX + 1),
	`${'ü'.repeat(121)}@example.com`,
	`${'ü'.repeat(122)}@example.com`,
	'ü'.repeat(130),
	1
];
const USERNAMES: ReadonlyArray<unknown> = [
	'alice',
	'AliCe',
	'a1',
	'abc',
	'a'.repeat(USERNAME_LENGTH_MAX),
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
	1
];
const EVENT_TYPES: ReadonlyArray<unknown> = [
	'login',
	'app.thing/created-v2',
	'a',
	'a'.repeat(NAME_LENGTH_MAX),
	'a'.repeat(NAME_LENGTH_MAX + 1),
	'1'.repeat(NAME_LENGTH_MAX + 1),
	'',
	'1login',
	'log in',
	1
];
const OUTCOMES: ReadonlyArray<unknown> = ['success', 'failure', 'Success', 'maybe', '', 0];
const STRINGS: ReadonlyArray<unknown> = [NOW, '', 'x', 1];
const ACTING: ReadonlyArray<unknown> = [...UUIDS, null];

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
	out.push(['unknown key and a bad field', { ...base, [Object.keys(fields)[0]!]: 'x', extra: 1 }]);
	for (const value of [null, undefined, [], 'x', 1]) out.push([`not an object: ${value}`, value]);
	return out;
};

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

const is_trailing_check = (issue: WireIssue | undefined): boolean =>
	issue?.kind === 'check' &&
	JSON.stringify(issue.path) === '["email"]' &&
	issue.message === INVITE_TARGET_REQUIRED_MESSAGE;

/** The custom messages Zod's issues carry, which the fuz_schema issues keep behind their path. */
const CUSTOM_MESSAGES: ReadonlyArray<string> = [
	INVITE_TARGET_REQUIRED_MESSAGE,
	EMAIL_LENGTH_MESSAGE,
	AUDIT_EVENT_TYPE_NAME_LENGTH_MESSAGE,
	AUDIT_EVENT_TYPE_NAME_PATTERN_MESSAGE
];

interface Counts {
	matched: number;
	refused: number;
	trailing_check: number;
	one_length_issue: number;
	email_bound: number;
	array_username: number;
	one_bound_issue: number;
	custom_message: number;
}

const run = (
	schema: ValidationSchema,
	zod_schema: ValidationSchema,
	corpus: ReadonlyArray<[string, unknown]>
): Counts => {
	const counts: Counts = {
		matched: 0,
		refused: 0,
		trailing_check: 0,
		one_length_issue: 0,
		email_bound: 0,
		array_username: 0,
		one_bound_issue: 0,
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
		assert.ok(!fuz.ok && !zod.ok, `${label}: the verdicts differ`);
		counts.refused++;
		let zod_issues = zod.issues;
		// declared: one length issue where Zod gives the length and the grammar
		zod_issues = zod_issues.filter((issue, i) => {
			const prev = zod_issues[i - 1];
			const key = issue.path.at(-1);
			const dropped =
				issue.kind === 'regex' &&
				(key === 'username' || key === 'event_type') &&
				(prev?.kind === 'max_length' || prev?.kind === 'min_length') &&
				same_path(prev, issue);
			if (dropped) counts.one_length_issue++;
			return !dropped;
		});
		// declared: the email bound, one `max_length` past the code units, and
		// the grammar issue within them for an address off the grammar
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
			// the grammar issue carries no custom message
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
		// declared: one bound issue where Zod gives the safe range's and the bound's
		zod_issues = zod_issues.filter((issue, i) => {
			const next = zod_issues[i + 1];
			const dropped =
				issue.kind === 'max_value' &&
				issue.expected === `<= ${Number.MAX_SAFE_INTEGER}` &&
				issue.path.at(-1) === 'limit' &&
				next?.kind === 'max_value' &&
				same_path(next, issue);
			if (dropped) counts.one_bound_issue++;
			return !dropped;
		});
		// declared: the trailing check after a field failure that doesn't abort
		if (zod_issues.length === fuz.issues.length + 1 && is_trailing_check(zod_issues.at(-1))) {
			assert.notOk(fuz.issues.some(is_trailing_check), label);
			zod_issues = zod_issues.slice(0, -1);
			counts.trailing_check++;
		}
		assert.deepStrictEqual(fuz.issues.map(without_message), zod_issues.map(without_message), label);
		// a custom Zod message is kept, behind the issue's path
		for (const [i, issue] of zod_issues.entries()) {
			if (!CUSTOM_MESSAGES.includes(issue.message)) continue;
			counts.custom_message++;
			assert.strictEqual(
				fuz.issues[i]!.message,
				`${issue.path.join('.')}: ${issue.message}`,
				label
			);
		}
	}
	return counts;
};

describe('the admin schemas agree with the Zod ones', () => {
	test('every input of all_admin_action_specs is a fuz_schema schema', () => {
		for (const spec of all_admin_action_specs) {
			assert.ok(is_schema(spec.input), spec.method);
		}
	});

	test('every output of all_admin_action_specs is a fuz_schema schema', () => {
		for (const spec of all_admin_action_specs) {
			assert.ok(is_schema(spec.output), spec.method);
		}
	});

	test('invite_create, but for the trailing check, one length issue, the email bound and the array username', () => {
		const corpus: Array<[string, unknown]> = [
			...corpus_of(
				{ email: 'user@example.com' },
				{ email: [...EMAILS, ...NULLISH], username: [...USERNAMES, ...NULLISH], acting: ACTING }
			),
			...corpus_of(
				{ username: 'alice' },
				{ email: [...EMAILS, ...NULLISH], username: [...USERNAMES, ...NULLISH], acting: ACTING }
			),
			// neither target, beside a field failure that doesn't abort
			['neither, bad acting', { acting: 'x' }],
			['neither, unknown key', { extra: 1 }],
			['nulls, unknown key', { email: null, username: null, extra: 1 }]
		];
		const counts = run(InviteCreateInput, ZodInviteCreateInput, corpus);
		assert.ok(counts.matched >= 20, JSON.stringify(counts));
		assert.ok(counts.refused >= 40, JSON.stringify(counts));
		assert.ok(counts.trailing_check >= 3, JSON.stringify(counts));
		assert.ok(counts.one_length_issue >= 4, JSON.stringify(counts));
		assert.ok(counts.email_bound >= 6, JSON.stringify(counts));
		assert.ok(counts.array_username >= 2, JSON.stringify(counts));
		assert.ok(counts.custom_message >= 6, JSON.stringify(counts));
	});

	test('invite_create given neither target fails at email with the Zod message', () => {
		for (const input of [
			{},
			{ email: null },
			{ username: undefined },
			{ email: null, username: null }
		]) {
			const fuz = outcome_of(InviteCreateInput, input);
			assert.ok(!fuz.ok);
			assert.deepStrictEqual(fuz.issues, [
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

	test('the paged and filtered inputs, their limits, offsets and filters included', () => {
		const accounts = run(
			AdminAccountListInput,
			ZodAccountListInput,
			corpus_of(
				{},
				{
					acting: ACTING,
					limit: [...limits(ADMIN_ACCOUNT_LIST_LIMIT_MAX), ...NULLISH],
					offset: [...COUNTS, ...NULLISH],
					include_deleted: [...BOOLEANS, ...NULLISH]
				}
			)
		);
		assert.ok(accounts.matched >= 15 && accounts.refused >= 25, JSON.stringify(accounts));
		assert.ok(accounts.one_bound_issue >= 2, JSON.stringify(accounts));
		const audit = run(
			AuditLogListInput,
			ZodAuditLogListInput,
			corpus_of(
				{},
				{
					event_type: [...EVENT_TYPES, ...NULLISH],
					outcome: [...OUTCOMES, ...NULLISH],
					account_id: [...UUIDS, ...NULLISH],
					limit: [...limits(AUDIT_LOG_LIST_LIMIT_MAX), ...NULLISH],
					offset: [...COUNTS, ...NULLISH],
					since_seq: [...COUNTS, ...NULLISH],
					acting: ACTING
				}
			)
		);
		assert.ok(audit.matched >= 30 && audit.refused >= 40, JSON.stringify(audit));
		assert.ok(audit.one_bound_issue >= 2, JSON.stringify(audit));
		assert.ok(audit.one_length_issue >= 1, JSON.stringify(audit));
		assert.ok(audit.custom_message >= 4, JSON.stringify(audit));
		const history = run(
			AuditLogRoleGrantHistoryInput,
			ZodRoleGrantHistoryInput,
			corpus_of(
				{},
				{
					limit: [...limits(AUDIT_LOG_LIST_LIMIT_MAX), ...NULLISH],
					offset: [...COUNTS, ...NULLISH],
					acting: ACTING
				}
			)
		);
		assert.ok(history.matched >= 10 && history.refused >= 20, JSON.stringify(history));
		// the safe range bounds `offset` and `since_seq` as Zod's `.int()` does
		for (const value of [Number.MAX_SAFE_INTEGER + 1, 2 ** 53 + 2, 1e16]) {
			assert.ok(!parse_any(AdminAccountListInput, { offset: value }).ok, String(value));
			assert.ok(!parse_any(AuditLogListInput, { since_seq: value }).ok, String(value));
		}
		assert.ok(parse_any(AuditLogListInput, { since_seq: Number.MAX_SAFE_INTEGER }).ok);
	});

	test('the acting-only, account-id and settings inputs', () => {
		for (const schema of [AdminSessionListInput, InviteListInput, AppSettingsGetInput]) {
			const counts = run(schema, ZodActingInput, corpus_of({}, { acting: ACTING }));
			assert.ok(counts.matched >= 5 && counts.refused >= 8, JSON.stringify(counts));
		}
		for (const schema of [
			AdminSessionRevokeAllInput,
			AdminTokenRevokeAllInput,
			AccountUndeleteInput
		]) {
			const counts = run(
				schema,
				ZodAccountIdInput,
				corpus_of({ account_id: ID }, { account_id: UUIDS, acting: ACTING })
			);
			assert.ok(counts.matched >= 5 && counts.refused >= 10, JSON.stringify(counts));
		}
		const invite_delete = run(
			InviteDeleteInput,
			ZodInviteDeleteInput,
			corpus_of({ invite_id: ID }, { invite_id: UUIDS, acting: ACTING })
		);
		assert.ok(
			invite_delete.matched >= 5 && invite_delete.refused >= 10,
			JSON.stringify(invite_delete)
		);
		const account_delete = run(
			AccountDeleteInput,
			ZodAccountDeleteInput,
			corpus_of({}, { account_id: [...UUIDS, ...NULLISH], acting: ACTING })
		);
		assert.ok(
			account_delete.matched >= 5 && account_delete.refused >= 8,
			JSON.stringify(account_delete)
		);
		const purge = run(
			AccountPurgeInput,
			ZodAccountPurgeInput,
			corpus_of(
				{ account_id: ID, confirm: true },
				{ account_id: UUIDS, confirm: [...BOOLEANS, ...NULLISH], acting: ACTING }
			)
		);
		assert.ok(purge.matched >= 8 && purge.refused >= 12, JSON.stringify(purge));
		const update = run(
			AppSettingsUpdateInput,
			ZodAppSettingsUpdateInput,
			corpus_of({ open_signup: true }, { open_signup: [...BOOLEANS, ...NULLISH], acting: ACTING })
		);
		assert.ok(update.matched >= 5 && update.refused >= 10, JSON.stringify(update));
	});

	test('an omitted defaulted input reads as a fresh {} in both', () => {
		for (const schema of [
			AdminAccountListInput,
			AdminSessionListInput,
			AuditLogListInput,
			AuditLogRoleGrantHistoryInput,
			InviteListInput,
			AccountDeleteInput,
			AppSettingsGetInput,
			ZodAccountListInput,
			ZodAuditLogListInput
		]) {
			const a = parse_any(schema, undefined);
			const b = parse_any(schema, undefined);
			assert.ok(a.ok && b.ok);
			assert.deepStrictEqual(a.value, {});
			assert.notStrictEqual(a.value, b.value);
		}
	});

	test('the row-free outputs, but for the count', () => {
		for (const schema of [AdminSessionRevokeAllOutput, AdminTokenRevokeAllOutput]) {
			const counts = run(
				schema,
				ZodRevokeAllOutput,
				corpus_of(
					{ ok: true, count: 0 },
					{ ok: [true, false, 1], count: [0, 3, -0, NaN, Infinity, '1', null] }
				)
			);
			assert.ok(counts.matched >= 4 && counts.refused >= 10, JSON.stringify(counts));
			// declared: the count is a non-negative integer, where Zod took any number
			for (const count of [1.5, -1, -0.5, Number.MIN_VALUE]) {
				assert.ok(ZodRevokeAllOutput.safeParse({ ok: true, count }).success, String(count));
				assert.ok(!parse_any(schema, { ok: true, count }).ok, String(count));
			}
		}
		const ok = run(
			InviteDeleteOutput,
			ZodOkOutput,
			corpus_of({ ok: true }, { ok: [true, false, 1] })
		);
		assert.ok(ok.matched === 2 && ok.refused >= 6, JSON.stringify(ok));
		for (const [schema, zod_schema, key] of [
			[AccountDeleteOutput, ZodAccountDeleteOutput, 'deleted'],
			[AccountPurgeOutput, ZodAccountPurgeOutput, 'purged'],
			[AccountUndeleteOutput, ZodAccountUndeleteOutput, 'undeleted']
		] as const) {
			const counts = run(
				schema,
				zod_schema,
				corpus_of({ ok: true, [key]: true }, { ok: [true, false], [key]: BOOLEANS })
			);
			assert.ok(counts.matched >= 3 && counts.refused >= 8, JSON.stringify(counts));
		}
	});

	test('the app settings schemas and outputs', () => {
		const settings = { open_signup: true, updated_at: NOW, updated_by: ID };
		const settings_fields: Fields = {
			open_signup: BOOLEANS,
			updated_at: [...STRINGS, null],
			updated_by: [...UUIDS, null]
		};
		const json = run(AppSettingsJson, ZodAppSettingsJson, corpus_of(settings, settings_fields));
		assert.ok(json.matched >= 8 && json.refused >= 12, JSON.stringify(json));
		const with_username = { ...settings, updated_by_username: 'alice' };
		const with_username_fields: Fields = {
			...settings_fields,
			updated_by_username: [...STRINGS, null]
		};
		const row = run(
			AppSettingsWithUsernameJson,
			ZodAppSettingsWithUsernameJson,
			corpus_of(with_username, with_username_fields)
		);
		assert.ok(row.matched >= 12 && row.refused >= 15, JSON.stringify(row));
		// the outputs, each with its settings changed
		const wrapped = (base: Record<string, unknown>): Array<[string, unknown]> =>
			corpus_of(with_username, with_username_fields).map(([label, s]): [string, unknown] => [
				`settings ${label}`,
				{ ...base, settings: s }
			]);
		const get = run(AppSettingsGetOutput, ZodAppSettingsGetOutput, [
			...wrapped({}),
			...corpus_of({ settings: with_username }, { settings: [null, {}, 'x'] })
		]);
		assert.ok(get.matched >= 12 && get.refused >= 15, JSON.stringify(get));
		const update = run(AppSettingsUpdateOutput, ZodAppSettingsUpdateOutput, [
			...wrapped({ ok: true }),
			...corpus_of({ ok: true, settings: with_username }, { ok: [true, false], settings: [null] })
		]);
		assert.ok(update.matched >= 12 && update.refused >= 15, JSON.stringify(update));
	});

	test('a username both outside its bounds and off the grammar gets the length issue alone', () => {
		for (const username of ['a', '1'.repeat(USERNAME_LENGTH_MAX + 1)]) {
			assert.ok(!USERNAME_REGEX.test(username));
			const fuz = outcome_of(InviteCreateInput, { username });
			const zod = outcome_of(ZodInviteCreateInput, { username });
			assert.ok(!fuz.ok && !zod.ok);
			assert.strictEqual(fuz.issues.length, 1, username);
			assert.strictEqual(zod.issues.length, 2, username);
		}
		const long_off = '1'.repeat(NAME_LENGTH_MAX + 1);
		assert.ok(!AUDIT_EVENT_TYPE_NAME_REGEX.test(long_off));
		const fuz = outcome_of(AuditLogListInput, { event_type: long_off });
		assert.ok(!fuz.ok);
		assert.deepStrictEqual(
			fuz.issues.map((i) => [i.kind, i.message]),
			[['max_length', `event_type: ${AUDIT_EVENT_TYPE_NAME_LENGTH_MESSAGE}`]]
		);
	});
});
