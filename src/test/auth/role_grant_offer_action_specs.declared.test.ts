/**
 * The role_grant_offer domain's schemas — the inputs, the outputs,
 * `RoleGrantOfferJson`, and the notification params: their valid samples, and
 * the verdicts and issue shapes that differ from the schemas they were ported
 * from, pinned case by case.
 *
 * - **the trailing check**: the pairing check of the create and assign
 *   inputs runs only on an input whose fields passed, so a field failure on a
 *   half-scoped input gets its own issue alone.
 * - **one length issue**: a `role` or `scope_kind` both too long and off the
 *   grammar gets the length issue alone.
 * - **the strict output `scope_kind`**: an offer's `scope_kind` is a
 *   `ScopeKindName` or `null`, so an output or notification holding one off
 *   the grammar fails.
 * - **the strict output timestamp**: an offer's timestamps are `Timestamp`,
 *   an RFC 3339 date and time in UTC. Both spines write
 *   `YYYY-MM-DDTHH:MM:SSZ`.
 * - **one bound issue**: a history `limit` past `Number.MAX_SAFE_INTEGER`
 *   gets the `max_value` issue of its bound alone.
 * - **revoke's required key**: `role_grant_revoked`'s params require a
 *   `scope_kind` beside `scope_id`.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { is_schema } from '@fuzdev/fuz_schema/schema.ts';

import { ROLE_GRANT_REVOKED_REASON_LENGTH_MAX } from '#lib/auth/account_schema.ts';
import {
	ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX,
	RoleGrantOfferJson
} from '#lib/auth/role_grant_offer_schema.ts';
import {
	GRANT_SCOPE_PAIRED_MESSAGE,
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
import { NAME_LENGTH_MAX, NAME_REGEX } from '#lib/auth/name_schema.ts';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const NOW = '2026-11-05T12:00:00.000Z';
const ASTRAL = '\u{1F600}';
const NAME_REGEX_TEXT = String(NAME_REGEX);

const OFFER = {
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
const GRANT_GLOBAL = { to_account_id: ID, role: 'teacher' };
const GRANT_SCOPED = { ...GRANT_GLOBAL, scope_kind: 'classroom', scope_id: ID2 };
const REVOKED = {
	role_grant_id: ID,
	role: 'admin',
	scope_kind: null,
	scope_id: null,
	reason: null
};

const issues_of = (schema: ValidationSchema, input: unknown): Array<WireIssue> | null => {
	const result = parse_any(schema, input);
	return result.ok ? null : to_wire_issues(result.issues, input);
};

/** The issues as `[kind, path, expected]`, or `null` for an acceptance. */
const shape_of = (schema: ValidationSchema, input: unknown): Array<unknown> | null =>
	issues_of(schema, input)?.map((i) => [i.kind, i.path, i.expected]) ?? null;

/** Each schema that holds an offer, and the offer wrapped as it holds one. */
const OFFER_HOLDERS: ReadonlyArray<
	[string, ValidationSchema, (offer: unknown) => unknown, Array<unknown>]
> = [
	['RoleGrantOfferJson', RoleGrantOfferJson, (o) => o, []],
	['RoleGrantOfferCreateOutput', RoleGrantOfferCreateOutput, (o) => ({ offer: o }), ['offer']],
	['RoleGrantOfferDeclineOutput', RoleGrantOfferDeclineOutput, (o) => ({ offer: o }), ['offer']],
	['RoleGrantOfferRetractOutput', RoleGrantOfferRetractOutput, (o) => ({ offer: o }), ['offer']],
	[
		'RoleGrantOfferAcceptOutput',
		RoleGrantOfferAcceptOutput,
		(o) => ({ role_grant_id: ID, offer: o, superseded_offer_ids: [ID2] }),
		['offer']
	],
	[
		'RoleGrantOfferListOutput',
		RoleGrantOfferListOutput,
		(o) => ({ offers: [OFFER, o] }),
		['offers', 1]
	],
	[
		'RoleGrantOfferHistoryOutput',
		RoleGrantOfferHistoryOutput,
		(o) => ({ offers: [OFFER, o] }),
		['offers', 1]
	],
	['RoleGrantOfferReceivedParams', RoleGrantOfferReceivedParams, (o) => ({ offer: o }), ['offer']],
	[
		'RoleGrantOfferRetractedParams',
		RoleGrantOfferRetractedParams,
		(o) => ({ offer: o }),
		['offer']
	],
	['RoleGrantOfferAcceptedParams', RoleGrantOfferAcceptedParams, (o) => ({ offer: o }), ['offer']],
	['RoleGrantOfferDeclinedParams', RoleGrantOfferDeclinedParams, (o) => ({ offer: o }), ['offer']],
	[
		'RoleGrantOfferSupersedeParams',
		RoleGrantOfferSupersedeParams,
		(o) => ({ offer: o, reason: 'sibling_accepted', cause_id: ID }),
		['offer']
	]
];

const samples: ReadonlyArray<[string, ValidationSchema, ReadonlyArray<unknown>]> = [
	[
		'RoleGrantOfferCreateInput',
		RoleGrantOfferCreateInput,
		[
			GRANT_GLOBAL,
			GRANT_SCOPED,
			{
				...GRANT_SCOPED,
				to_actor_id: ID2,
				message: 'a'.repeat(ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX)
			}
		]
	],
	['RoleGrantAssignInput', RoleGrantAssignInput, [GRANT_GLOBAL, GRANT_SCOPED]],
	['RoleGrantOfferAcceptInput', RoleGrantOfferAcceptInput, [{ offer_id: ID }]],
	['RoleGrantOfferRetractInput', RoleGrantOfferRetractInput, [{ offer_id: ID, acting: ID2 }]],
	[
		'RoleGrantOfferDeclineInput',
		RoleGrantOfferDeclineInput,
		[
			{ offer_id: ID },
			{ offer_id: ID, reason: ASTRAL.repeat(ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX / 2) }
		]
	],
	[
		'RoleGrantRevokeInput',
		RoleGrantRevokeInput,
		[
			{ actor_id: ID, role_grant_id: ID2 },
			{ actor_id: ID, role_grant_id: ID2, reason: 'a'.repeat(ROLE_GRANT_REVOKED_REASON_LENGTH_MAX) }
		]
	],
	['RoleGrantOfferListInput', RoleGrantOfferListInput, [undefined, {}, { account_id: ID }]],
	[
		'RoleGrantOfferHistoryInput',
		RoleGrantOfferHistoryInput,
		[{}, { limit: ROLE_GRANT_OFFER_HISTORY_LIMIT_MAX, offset: Number.MAX_SAFE_INTEGER }]
	],
	['RoleGrantRevokeOutput', RoleGrantRevokeOutput, [{ ok: true, revoked: true }]],
	['RoleGrantAssignOutput', RoleGrantAssignOutput, [{ ok: true, role_grant_id: ID }]],
	[
		'RoleGrantRevokedParams',
		RoleGrantRevokedParams,
		[REVOKED, { ...REVOKED, scope_kind: 'classroom', scope_id: ID2 }]
	],
	...OFFER_HOLDERS.map(([name, schema, wrap]): [string, ValidationSchema, Array<unknown>] => [
		name,
		schema,
		[
			wrap(OFFER),
			wrap({ ...OFFER, scope_kind: null, scope_id: null, accepted_at: '2026-11-05T12:00:00Z' })
		]
	])
];

describe('the role_grant_offer schemas', () => {
	test.each(samples)(
		'%s is a fuz_schema schema taking every valid sample',
		(_name, schema, values) => {
			assert.ok(is_schema(schema));
			for (const value of values) {
				assert.ok(parse_any(schema, value).ok, JSON.stringify(value));
			}
		}
	);

	test('an omitted list or history input reads as a fresh {}', () => {
		for (const schema of [RoleGrantOfferListInput, RoleGrantOfferHistoryInput]) {
			const a = parse_any(schema, undefined);
			const b = parse_any(schema, undefined);
			assert.ok(a.ok && b.ok);
			assert.deepStrictEqual(a.value, {});
			assert.notStrictEqual(a.value, b.value);
		}
	});

	test('the safe range bounds the history offset', () => {
		for (const offset of [Number.MAX_SAFE_INTEGER + 1, 2 ** 53 + 2, 1e16]) {
			assert.ok(!parse_any(RoleGrantOfferHistoryInput, { offset }).ok, String(offset));
		}
		assert.ok(parse_any(RoleGrantOfferHistoryInput, { offset: Number.MAX_SAFE_INTEGER }).ok);
	});
});

describe('the declared differences, pinned', () => {
	test('the half-scoped inputs fail the check alone when every field passes', () => {
		for (const schema of [RoleGrantOfferCreateInput, RoleGrantAssignInput]) {
			for (const input of [
				{ ...GRANT_GLOBAL, scope_id: ID2 },
				{ ...GRANT_GLOBAL, scope_kind: 'classroom' },
				{ ...GRANT_GLOBAL, scope_kind: 'classroom', scope_id: null }
			]) {
				assert.deepStrictEqual(issues_of(schema, input), [
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

	test('the trailing check: a half-scoped input with a field failure gets its issue alone', () => {
		for (const schema of [RoleGrantOfferCreateInput, RoleGrantAssignInput]) {
			assert.deepStrictEqual(shape_of(schema, { to_account_id: ID, role: '_a', scope_id: ID2 }), [
				['regex', ['role'], NAME_REGEX_TEXT]
			]);
			assert.deepStrictEqual(
				shape_of(schema, { to_account_id: 'x', role: 'teacher', scope_kind: 'classroom' }),
				[['uuid', ['to_account_id'], 'uuid']]
			);
			assert.deepStrictEqual(shape_of(schema, { ...GRANT_GLOBAL, scope_id: ID2, extra: 1 }), [
				['unknown_key', ['extra'], 'no unknown keys']
			]);
		}
	});

	test('one length issue: a role or scope_kind too long and off the grammar', () => {
		const long_off = 'A'.repeat(NAME_LENGTH_MAX + 1);
		for (const schema of [RoleGrantOfferCreateInput, RoleGrantAssignInput]) {
			assert.isNull(issues_of(schema, { ...GRANT_GLOBAL, role: 'a'.repeat(NAME_LENGTH_MAX) }));
			assert.deepStrictEqual(shape_of(schema, { ...GRANT_GLOBAL, role: long_off }), [
				['max_length', ['role'], `length <= ${NAME_LENGTH_MAX}`]
			]);
			assert.deepStrictEqual(shape_of(schema, { ...GRANT_SCOPED, scope_kind: long_off }), [
				['max_length', ['scope_kind'], `length <= ${NAME_LENGTH_MAX}`]
			]);
		}
		assert.deepStrictEqual(shape_of(RoleGrantRevokedParams, { ...REVOKED, role: long_off }), [
			['max_length', ['role'], `length <= ${NAME_LENGTH_MAX}`]
		]);
	});

	test.each(OFFER_HOLDERS)(
		'%s holds a strict scope_kind and strict timestamps',
		(_name, schema, wrap, at) => {
			for (const scope_kind of ['classroom', 'a_b', null]) {
				assert.isNull(issues_of(schema, wrap({ ...OFFER, scope_kind })), String(scope_kind));
			}
			for (const scope_kind of ['GLOBAL', 'a__b', '', ASTRAL]) {
				assert.deepStrictEqual(shape_of(schema, wrap({ ...OFFER, scope_kind })), [
					['regex', [...at, 'scope_kind'], NAME_REGEX_TEXT]
				]);
			}
			assert.deepStrictEqual(
				shape_of(schema, wrap({ ...OFFER, scope_kind: 'a'.repeat(NAME_LENGTH_MAX + 1) })),
				[['max_length', [...at, 'scope_kind'], `length <= ${NAME_LENGTH_MAX}`]]
			);
			for (const t of ['2026-11-05T12:00:00Z', '2026-11-05T12:00:00.123456789Z']) {
				assert.isNull(issues_of(schema, wrap({ ...OFFER, accepted_at: t })), t);
			}
			for (const [key, t] of [
				['accepted_at', '2026-11-05 12:00:00+00'],
				['created_at', '2026-11-05T12:00:00+00:00'],
				['expires_at', '2026-02-30T00:00:00Z'],
				['superseded_at', 'x']
			] as const) {
				assert.deepStrictEqual(shape_of(schema, wrap({ ...OFFER, [key]: t })), [
					['iso_datetime', [...at, key], 'iso_datetime']
				]);
			}
		}
	);

	test("one bound issue: a history limit past the safe range gets its bound's issue alone", () => {
		assert.isNull(
			issues_of(RoleGrantOfferHistoryInput, { limit: ROLE_GRANT_OFFER_HISTORY_LIMIT_MAX })
		);
		for (const limit of [Number.MAX_SAFE_INTEGER + 1, 1e308]) {
			assert.deepStrictEqual(shape_of(RoleGrantOfferHistoryInput, { limit }), [
				['max_value', ['limit'], `<= ${ROLE_GRANT_OFFER_HISTORY_LIMIT_MAX}`]
			]);
		}
	});

	test('the revoke params require scope_kind', () => {
		assert.isNull(issues_of(RoleGrantRevokedParams, REVOKED));
		const { scope_kind: _, ...without } = REVOKED;
		assert.deepStrictEqual(shape_of(RoleGrantRevokedParams, without), [
			['string', ['scope_kind'], 'string']
		]);
		assert.deepStrictEqual(shape_of(RoleGrantRevokedParams, { ...REVOKED, scope_kind: 'GLOBAL' }), [
			['regex', ['scope_kind'], NAME_REGEX_TEXT]
		]);
	});
});
