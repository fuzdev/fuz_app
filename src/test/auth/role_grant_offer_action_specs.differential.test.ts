/**
 * The role_grant_offer domain's `@fuzdev/fuz_schema` schemas, held to the Zod
 * schemas they replaced, rebuilt here: the inputs, the outputs,
 * `RoleGrantOfferJson`, and the notification params. On corpora of single
 * changes to a valid value, each pair gives the same verdict and output, and
 * the same wire issues but for `message`.
 *
 * Declared differences, each recognized where it is allowed and counted:
 *
 * - **the trailing check**: Zod still runs the pairing refine of the create
 *   and assign inputs after a field failure that doesn't abort (a regex, a
 *   UUID format, an unknown key), adding a `check` issue on the input; the
 *   `check` that ends the fuz_schema `pipe` runs only on an input whose fields
 *   passed. Production answers carry no issues, and neither input declares an
 *   `invalid_reason`, so the answers are the same there.
 * - **one length issue**: a `role` or `scope_kind` both too long and off the
 *   grammar gets the length issue alone, where Zod adds the grammar issue.
 * - **the strict output `scope_kind`**: an offer's `scope_kind` is a
 *   `ScopeKindName` or `null` (Zod: any string or `null`), so an output or
 *   notification holding one off the grammar fails.
 * - **one bound issue**: a history `limit` past `Number.MAX_SAFE_INTEGER`
 *   gets the `max_value` issue of its bound alone, where Zod's `.int()` adds
 *   the safe-range `max_value` issue before it. The reason is the same.
 * - **revoke's new key**: `role_grant_revoked`'s params require a
 *   `scope_kind`, beside `scope_id`. Held here to the Zod params with that
 *   key added, and the Zod params as they were refuse it as unknown.
 *
 * The list and history inputs read an omitted input as a fresh `{}` in both.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';
import { is_schema } from '@fuzdev/fuz_schema/schema.ts';

import { Uuid as ZodUuid, bounded_string as zod_bounded_string } from '#lib/primitive_schemas.ts';
import { ActingActor as ZodActingActor } from '#lib/http/auth_shape.ts';
import { RoleName as ZodRoleName } from '#lib/auth/role_schema.ts';
import { ScopeKindName as ZodScopeKindName } from '#lib/auth/scope_kind_schema.ts';
import { ROLE_GRANT_REVOKED_REASON_LENGTH_MAX } from '#lib/auth/account_schema.ts';
import {
	ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX,
	RoleGrantOfferJson
} from '#lib/auth/role_grant_offer_schema.ts';
import {
	GRANT_SCOPE_PAIRED_MESSAGE,
	is_grant_scope_paired,
	ROLE_GRANT_OFFER_HISTORY_LIMIT_MAX,
	RoleGrantAssignInput,
	RoleGrantAssignOutput,
	RoleGrantOfferAcceptInput,
	RoleGrantOfferAcceptOutput,
	RoleGrantOfferCreateInput,
	RoleGrantOfferCreateOutput,
	RoleGrantOfferDeclineInput,
	RoleGrantOfferDeclineOutput,
	RoleGrantOfferHistoryInput,
	RoleGrantOfferHistoryOutput,
	RoleGrantOfferListInput,
	RoleGrantOfferListOutput,
	RoleGrantOfferRetractInput,
	RoleGrantOfferRetractOutput,
	RoleGrantRevokeInput,
	RoleGrantRevokeOutput
} from '#lib/auth/role_grant_offer_action_specs.ts';
import {
	RoleGrantOfferAcceptedParams,
	RoleGrantOfferDeclinedParams,
	RoleGrantOfferReceivedParams,
	RoleGrantOfferRetractedParams,
	RoleGrantOfferSupersedeParams,
	RoleGrantRevokedParams
} from '#lib/auth/role_grant_offer_notifications.ts';
import {
	parse_any,
	to_wire_issues,
	type ValidationSchema,
	type WireIssue
} from '#lib/schema_issues.ts';
import { NAME_LENGTH_MAX } from '#lib/auth/name_schema.ts';

// -- the Zod schemas the port replaced --------------------------------------

const ZodGrantScopeKind = ZodScopeKindName.nullish();

const ZodRoleGrantOfferJson = z.strictObject({
	id: ZodUuid,
	from_actor_id: ZodUuid,
	to_account_id: ZodUuid,
	to_actor_id: ZodUuid.nullable(),
	role: ZodRoleName,
	scope_kind: z.string().nullable(),
	scope_id: ZodUuid.nullable(),
	message: zod_bounded_string({ max: ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX }).nullable(),
	created_at: z.string(),
	expires_at: z.string(),
	accepted_at: z.string().nullable(),
	declined_at: z.string().nullable(),
	decline_reason: zod_bounded_string({ max: ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX }).nullable(),
	retracted_at: z.string().nullable(),
	superseded_at: z.string().nullable(),
	resulting_role_grant_id: ZodUuid.nullable()
});

const ZodCreateInput = z
	.strictObject({
		to_account_id: ZodUuid,
		to_actor_id: ZodUuid.nullish(),
		role: ZodRoleName,
		scope_kind: ZodGrantScopeKind,
		scope_id: ZodUuid.nullish(),
		message: zod_bounded_string({ max: ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX }).nullish(),
		acting: ZodActingActor
	})
	.refine(is_grant_scope_paired, { message: GRANT_SCOPE_PAIRED_MESSAGE });

const ZodOfferIdInput = z.strictObject({ offer_id: ZodUuid, acting: ZodActingActor });

const ZodDeclineInput = z.strictObject({
	offer_id: ZodUuid,
	reason: zod_bounded_string({ max: ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX }).nullish(),
	acting: ZodActingActor
});

const ZodListInput = z
	.strictObject({ account_id: ZodUuid.nullish(), acting: ZodActingActor })
	.default({});

const ZodRevokeInput = z.strictObject({
	actor_id: ZodUuid,
	role_grant_id: ZodUuid,
	reason: zod_bounded_string({ max: ROLE_GRANT_REVOKED_REASON_LENGTH_MAX }).nullish(),
	acting: ZodActingActor
});

const ZodHistoryInput = z
	.strictObject({
		account_id: ZodUuid.nullish(),
		limit: z.number().int().min(1).max(ROLE_GRANT_OFFER_HISTORY_LIMIT_MAX).nullish(),
		offset: z.number().int().min(0).nullish(),
		acting: ZodActingActor
	})
	.default({});

const ZodAssignInput = z
	.strictObject({
		to_account_id: ZodUuid,
		to_actor_id: ZodUuid.nullish(),
		role: ZodRoleName,
		scope_kind: ZodGrantScopeKind,
		scope_id: ZodUuid.nullish(),
		acting: ZodActingActor
	})
	.refine(is_grant_scope_paired, { message: GRANT_SCOPE_PAIRED_MESSAGE });

const ZodOfferOutput = z.strictObject({ offer: ZodRoleGrantOfferJson });
const ZodAcceptOutput = z.strictObject({
	role_grant_id: ZodUuid,
	offer: ZodRoleGrantOfferJson,
	superseded_offer_ids: z.array(ZodUuid)
});
const ZodOffersOutput = z.strictObject({ offers: z.array(ZodRoleGrantOfferJson) });
const ZodRevokeOutput = z.strictObject({ ok: z.literal(true), revoked: z.literal(true) });
const ZodAssignOutput = z.strictObject({ ok: z.literal(true), role_grant_id: ZodUuid });

const ZodSupersedeParams = z.strictObject({
	offer: ZodRoleGrantOfferJson,
	reason: z.enum(['sibling_accepted', 'role_grant_revoked', 'scope_destroyed']),
	cause_id: ZodUuid
});
const ZodRevokeParamsAtCapture = z.strictObject({
	role_grant_id: ZodUuid,
	role: ZodRoleName,
	scope_id: ZodUuid.nullable(),
	reason: zod_bounded_string({ max: ROLE_GRANT_REVOKED_REASON_LENGTH_MAX }).nullable()
});
// declared: the params gain a required `scope_kind`
const ZodRevokeParams = ZodRevokeParamsAtCapture.extend({
	scope_kind: ZodScopeKindName.nullable()
});

// -- corpora ----------------------------------------------------------------

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
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
const ROLES: ReadonlyArray<unknown> = [
	'admin',
	'teacher',
	'a',
	'a_b',
	'a'.repeat(NAME_LENGTH_MAX),
	'a'.repeat(NAME_LENGTH_MAX + 1),
	'A'.repeat(NAME_LENGTH_MAX + 1),
	'',
	'Admin',
	'a__b',
	'_a',
	ASTRAL,
	1
];
const SCOPE_KINDS: ReadonlyArray<unknown> = [
	'classroom',
	'a_b',
	'a'.repeat(NAME_LENGTH_MAX),
	'a'.repeat(NAME_LENGTH_MAX + 1),
	'A'.repeat(NAME_LENGTH_MAX + 1),
	'GLOBAL',
	'a__b',
	'',
	ASTRAL,
	1
];
const texts = (max: number): ReadonlyArray<unknown> => [
	'',
	'a note',
	'a'.repeat(max),
	'a'.repeat(max + 1),
	ASTRAL.repeat(max / 2),
	ASTRAL.repeat(max / 2) + 'a',
	1,
	false
];
const STRINGS: ReadonlyArray<unknown> = [NOW, '', 'x', 1, null];
const LIMITS: ReadonlyArray<unknown> = [
	1,
	100,
	ROLE_GRANT_OFFER_HISTORY_LIMIT_MAX,
	0,
	-1,
	ROLE_GRANT_OFFER_HISTORY_LIMIT_MAX + 1,
	1.5,
	Number.MAX_SAFE_INTEGER + 1,
	1e308,
	'1',
	NaN,
	Infinity,
	true
];
const OFFSETS: ReadonlyArray<unknown> = [
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

type Pool = ReadonlyArray<unknown>;
type Fields = Record<string, Pool>;

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

const OFFER: Record<string, unknown> = {
	id: ID,
	from_actor_id: ID,
	to_account_id: ID2,
	to_actor_id: null,
	role: 'teacher',
	scope_kind: 'classroom',
	scope_id: ID2,
	message: null,
	created_at: NOW,
	expires_at: NOW,
	accepted_at: null,
	declined_at: null,
	decline_reason: null,
	retracted_at: null,
	superseded_at: null,
	resulting_role_grant_id: null
};
const OFFER_FIELDS: Fields = {
	id: UUIDS,
	from_actor_id: UUIDS,
	to_account_id: UUIDS,
	to_actor_id: [...UUIDS, null],
	role: ROLES,
	scope_kind: [...SCOPE_KINDS, null],
	scope_id: [...UUIDS, null],
	message: [...texts(ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX), null],
	created_at: STRINGS,
	expires_at: STRINGS,
	accepted_at: STRINGS,
	declined_at: STRINGS,
	decline_reason: [...texts(ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX), null],
	retracted_at: STRINGS,
	superseded_at: STRINGS,
	resulting_role_grant_id: [...UUIDS, null]
};
const OFFERS = corpus_of(OFFER, OFFER_FIELDS);

/** The offer corpus under `key` of `base`, and `base` itself changed. */
const offer_wrapped = (
	base: Record<string, unknown>,
	fields: Fields,
	wrap: (offer: unknown) => Record<string, unknown>
): Array<[string, unknown]> => [
	...corpus_of({ ...base, ...wrap(OFFER) }, fields),
	...OFFERS.map(([label, offer]): [string, unknown] => [
		`offer ${label}`,
		{ ...base, ...wrap(offer) }
	])
];

const ACTING: Pool = [...UUIDS, null];
const GRANT_FIELDS: Fields = {
	to_account_id: UUIDS,
	to_actor_id: [...UUIDS, ...NULLISH],
	role: ROLES,
	scope_kind: [...SCOPE_KINDS, ...NULLISH],
	scope_id: [...UUIDS, ...NULLISH],
	acting: ACTING
};
const GRANT_GLOBAL = { to_account_id: ID, role: 'teacher' };
const GRANT_SCOPED = { ...GRANT_GLOBAL, scope_kind: 'classroom', scope_id: ID2 };
const grant_corpus = (fields: Fields): Array<[string, unknown]> => [
	...corpus_of(GRANT_GLOBAL, fields).map(([l, v]): [string, unknown] => [`global ${l}`, v]),
	...corpus_of(GRANT_SCOPED, fields).map(([l, v]): [string, unknown] => [`scoped ${l}`, v]),
	// half-scoped with a field failure that doesn't abort, and with an unknown key
	['half-scoped, bad role', { to_account_id: ID, role: '_a', scope_id: ID2 }],
	['half-scoped, bad uuid', { to_account_id: 'x', role: 'teacher', scope_kind: 'classroom' }],
	['half-scoped, unknown key', { ...GRANT_GLOBAL, scope_id: ID2, extra: 1 }],
	[
		'half-scoped, bad field and unknown key',
		{ to_account_id: ID, role: 'A'.repeat(NAME_LENGTH_MAX + 1), scope_kind: 'room', extra: 1 }
	]
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

const is_name_key = (path: ReadonlyArray<unknown>): boolean =>
	path.at(-1) === 'role' || path.at(-1) === 'scope_kind';

const is_trailing_check = (issue: WireIssue | undefined): boolean =>
	issue?.kind === 'check' &&
	issue.path.length === 0 &&
	issue.message === GRANT_SCOPE_PAIRED_MESSAGE;

/** The value at `path` in `input`. */
const at_path = (input: unknown, path: ReadonlyArray<unknown>): unknown =>
	path.reduce<unknown>(
		(v, key) => (v as Record<PropertyKey, unknown>)?.[key as PropertyKey],
		input
	);

const off_scope_kind_grammar = (value: unknown): boolean =>
	typeof value === 'string' && !parse_any(ZodScopeKindName, value).ok;

interface Counts {
	matched: number;
	refused: number;
	trailing_check: number;
	one_length_issue: number;
	one_bound_issue: number;
	strict_scope_kind: number;
}

const run = (
	schema: ValidationSchema,
	zod_schema: ValidationSchema,
	corpus: ReadonlyArray<[string, unknown]>,
	allow: { trailing_check?: boolean; strict_scope_kind?: boolean } = {}
): Counts => {
	const counts: Counts = {
		matched: 0,
		refused: 0,
		trailing_check: 0,
		one_length_issue: 0,
		one_bound_issue: 0,
		strict_scope_kind: 0
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
			// declared: the strict output `scope_kind`, the one issue
			assert.ok(allow.strict_scope_kind, `${label}: fuz refused what Zod took`);
			assert.strictEqual(fuz.issues.length, 1, label);
			const issue = fuz.issues[0]!;
			assert.strictEqual(issue.path.at(-1), 'scope_kind', label);
			assert.include(['max_length', 'regex'], issue.kind, label);
			assert.ok(off_scope_kind_grammar(at_path(input, issue.path)), label);
			counts.strict_scope_kind++;
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
				is_name_key(issue.path) &&
				prev?.kind === 'max_length' &&
				JSON.stringify(prev.path) === JSON.stringify(issue.path);
			if (dropped) counts.one_length_issue++;
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
				JSON.stringify(next.path) === JSON.stringify(issue.path);
			if (dropped) counts.one_bound_issue++;
			return !dropped;
		});
		// declared: the trailing check after a field failure that doesn't abort
		if (
			allow.trailing_check &&
			zod_issues.length === fuz.issues.length + 1 &&
			is_trailing_check(zod_issues.at(-1))
		) {
			assert.notOk(fuz.issues.some(is_trailing_check), label);
			zod_issues = zod_issues.slice(0, -1);
			counts.trailing_check++;
		}
		assert.deepStrictEqual(fuz.issues.map(without_message), zod_issues.map(without_message), label);
	}
	return counts;
};

describe('the role_grant_offer schemas agree with the Zod ones', () => {
	test('are fuz_schema schemas', () => {
		for (const schema of [
			RoleGrantOfferJson,
			RoleGrantOfferCreateInput,
			RoleGrantOfferHistoryInput,
			RoleGrantRevokedParams
		]) {
			assert.ok(is_schema(schema));
		}
	});

	test('the create and assign inputs, but for the trailing check and one length issue', () => {
		for (const [schema, zod_schema, fields] of [
			[
				RoleGrantOfferCreateInput,
				ZodCreateInput,
				{
					...GRANT_FIELDS,
					message: [...texts(ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX), ...NULLISH]
				}
			],
			[RoleGrantAssignInput, ZodAssignInput, GRANT_FIELDS]
		] as const) {
			const counts = run(schema, zod_schema, grant_corpus(fields), { trailing_check: true });
			assert.ok(counts.matched >= 20, JSON.stringify(counts));
			assert.ok(counts.refused >= 60, JSON.stringify(counts));
			assert.ok(counts.trailing_check >= 4, JSON.stringify(counts));
			assert.ok(counts.one_length_issue >= 2, JSON.stringify(counts));
			assert.strictEqual(counts.strict_scope_kind, 0);
		}
	});

	test('the half-scoped inputs fail the check alone when every field passes', () => {
		for (const schema of [RoleGrantOfferCreateInput, RoleGrantAssignInput]) {
			for (const input of [
				{ ...GRANT_GLOBAL, scope_id: ID2 },
				{ ...GRANT_GLOBAL, scope_kind: 'classroom' },
				{ ...GRANT_GLOBAL, scope_kind: 'classroom', scope_id: null }
			]) {
				const fuz = outcome_of(schema, input);
				assert.ok(!fuz.ok);
				assert.deepStrictEqual(fuz.issues, [
					{
						kind: 'check',
						path: [],
						expected: 'check',
						received: 'object',
						message: GRANT_SCOPE_PAIRED_MESSAGE
					}
				]);
			}
		}
	});

	test('the offer-id, decline and revoke inputs', () => {
		const offer_id_fields: Fields = { offer_id: UUIDS, acting: ACTING };
		for (const [schema, zod_schema] of [
			[RoleGrantOfferAcceptInput, ZodOfferIdInput],
			[RoleGrantOfferRetractInput, ZodOfferIdInput]
		] as const) {
			const counts = run(schema, zod_schema, corpus_of({ offer_id: ID }, offer_id_fields));
			assert.ok(counts.matched >= 5 && counts.refused >= 10, JSON.stringify(counts));
		}
		const decline = run(
			RoleGrantOfferDeclineInput,
			ZodDeclineInput,
			corpus_of(
				{ offer_id: ID },
				{
					...offer_id_fields,
					reason: [...texts(ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX), ...NULLISH]
				}
			)
		);
		assert.ok(decline.matched >= 8 && decline.refused >= 10, JSON.stringify(decline));
		const revoke = run(
			RoleGrantRevokeInput,
			ZodRevokeInput,
			corpus_of(
				{ actor_id: ID, role_grant_id: ID2 },
				{
					actor_id: UUIDS,
					role_grant_id: UUIDS,
					reason: [...texts(ROLE_GRANT_REVOKED_REASON_LENGTH_MAX), ...NULLISH],
					acting: ACTING
				}
			)
		);
		assert.ok(revoke.matched >= 10 && revoke.refused >= 10, JSON.stringify(revoke));
	});

	test('the list and history inputs, their limits and offsets included', () => {
		const list = run(
			RoleGrantOfferListInput,
			ZodListInput,
			corpus_of({}, { account_id: [...UUIDS, ...NULLISH], acting: ACTING })
		);
		assert.ok(list.matched >= 5 && list.refused >= 8, JSON.stringify(list));
		const history = run(
			RoleGrantOfferHistoryInput,
			ZodHistoryInput,
			corpus_of(
				{},
				{
					account_id: [...UUIDS, ...NULLISH],
					limit: [...LIMITS, ...NULLISH],
					offset: [...OFFSETS, ...NULLISH],
					acting: ACTING
				}
			)
		);
		assert.ok(history.matched >= 15 && history.refused >= 25, JSON.stringify(history));
		assert.ok(history.one_bound_issue >= 2, JSON.stringify(history));
		// the safe range bounds `offset` as Zod's `.int()` does
		for (const offset of [Number.MAX_SAFE_INTEGER + 1, 2 ** 53 + 2, 1e16]) {
			assert.ok(!parse_any(RoleGrantOfferHistoryInput, { offset }).ok, String(offset));
		}
		assert.ok(parse_any(RoleGrantOfferHistoryInput, { offset: Number.MAX_SAFE_INTEGER }).ok);
	});

	test('an omitted list or history input reads as a fresh {} in both', () => {
		for (const schema of [
			RoleGrantOfferListInput,
			RoleGrantOfferHistoryInput,
			ZodListInput,
			ZodHistoryInput
		]) {
			const a = parse_any(schema, undefined);
			const b = parse_any(schema, undefined);
			assert.ok(a.ok && b.ok);
			assert.deepStrictEqual(a.value, {});
			assert.notStrictEqual(a.value, b.value);
		}
	});

	test('RoleGrantOfferJson, but for the strict scope_kind', () => {
		const counts = run(RoleGrantOfferJson, ZodRoleGrantOfferJson, OFFERS, {
			strict_scope_kind: true
		});
		assert.ok(counts.matched >= 30, JSON.stringify(counts));
		assert.ok(counts.refused >= 60, JSON.stringify(counts));
		assert.ok(counts.strict_scope_kind >= 6, JSON.stringify(counts));
		assert.ok(counts.one_length_issue >= 1, JSON.stringify(counts));
	});

	test('the outputs, but for the strict scope_kind', () => {
		const offer = (o: unknown) => ({ offer: o });
		const offers = (o: unknown) => ({ offers: [OFFER, o] });
		const allow = { strict_scope_kind: true };
		for (const [schema, zod_schema, corpus] of [
			[RoleGrantOfferCreateOutput, ZodOfferOutput, offer_wrapped({}, {}, offer)],
			[RoleGrantOfferDeclineOutput, ZodOfferOutput, offer_wrapped({}, {}, offer)],
			[RoleGrantOfferRetractOutput, ZodOfferOutput, offer_wrapped({}, {}, offer)],
			[
				RoleGrantOfferAcceptOutput,
				ZodAcceptOutput,
				offer_wrapped(
					{ role_grant_id: ID, superseded_offer_ids: [ID2] },
					{ role_grant_id: UUIDS, superseded_offer_ids: [[], [ID, 'x'], ID, null] },
					offer
				)
			],
			[RoleGrantOfferListOutput, ZodOffersOutput, offer_wrapped({}, {}, offers)],
			[RoleGrantOfferHistoryOutput, ZodOffersOutput, offer_wrapped({}, {}, offers)]
		] as const) {
			const counts = run(schema, zod_schema, corpus, allow);
			assert.ok(counts.matched >= 30 && counts.strict_scope_kind >= 6, JSON.stringify(counts));
		}
		const revoke = run(
			RoleGrantRevokeOutput,
			ZodRevokeOutput,
			corpus_of({ ok: true, revoked: true }, { ok: [true, false, 1], revoked: [true, false, 'x'] })
		);
		// the base, and each field set to the `true` it holds
		assert.ok(revoke.matched === 3 && revoke.refused >= 8, JSON.stringify(revoke));
		const assign = run(
			RoleGrantAssignOutput,
			ZodAssignOutput,
			corpus_of({ ok: true, role_grant_id: ID }, { ok: [true, false], role_grant_id: UUIDS })
		);
		assert.ok(assign.matched >= 4 && assign.refused >= 6, JSON.stringify(assign));
	});

	test('the offer notification params, but for the strict scope_kind', () => {
		const allow = { strict_scope_kind: true };
		for (const schema of [
			RoleGrantOfferReceivedParams,
			RoleGrantOfferRetractedParams,
			RoleGrantOfferAcceptedParams,
			RoleGrantOfferDeclinedParams
		]) {
			const counts = run(
				schema,
				ZodOfferOutput,
				offer_wrapped({}, {}, (o) => ({ offer: o })),
				allow
			);
			assert.ok(counts.matched >= 30 && counts.strict_scope_kind >= 6, JSON.stringify(counts));
		}
		const supersede = run(
			RoleGrantOfferSupersedeParams,
			ZodSupersedeParams,
			offer_wrapped(
				{ reason: 'sibling_accepted', cause_id: ID },
				{
					reason: ['sibling_accepted', 'role_grant_revoked', 'scope_destroyed', 'other', null, 1],
					cause_id: UUIDS
				},
				(o) => ({ offer: o })
			),
			allow
		);
		assert.ok(supersede.matched >= 30 && supersede.refused >= 60, JSON.stringify(supersede));
	});

	test('the revoke params, against the Zod ones with the new key', () => {
		const corpus = corpus_of(
			{ role_grant_id: ID, role: 'admin', scope_kind: null, scope_id: null, reason: null },
			{
				role_grant_id: UUIDS,
				role: ROLES,
				scope_kind: [...SCOPE_KINDS, null],
				scope_id: [...UUIDS, null],
				reason: [...texts(ROLE_GRANT_REVOKED_REASON_LENGTH_MAX), null]
			}
		);
		const counts = run(RoleGrantRevokedParams, ZodRevokeParams, corpus);
		assert.ok(counts.matched >= 15 && counts.refused >= 25, JSON.stringify(counts));
		assert.ok(counts.one_length_issue >= 2, JSON.stringify(counts));
		// declared: the key is required, which the params at capture refused as unknown
		const at_capture = { role_grant_id: ID, role: 'admin', scope_id: null, reason: null };
		const missing = outcome_of(RoleGrantRevokedParams, at_capture);
		assert.ok(!missing.ok);
		assert.deepStrictEqual(
			missing.issues.map((i) => [i.kind, i.path]),
			[['string', ['scope_kind']]]
		);
		assert.ok(parse_any(ZodRevokeParamsAtCapture, at_capture).ok);
		const with_key = outcome_of(ZodRevokeParamsAtCapture, { ...at_capture, scope_kind: null });
		assert.ok(!with_key.ok);
		assert.deepStrictEqual(
			with_key.issues.map((i) => [i.kind, i.path]),
			[['unknown_key', ['scope_kind']]]
		);
	});
});
