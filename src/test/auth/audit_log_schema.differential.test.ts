/**
 * The builtin `audit_metadata_schemas`, `@fuzdev/fuz_schema` schemas, held to
 * the Zod ones they replaced, rebuilt here without their descriptions, which
 * no verdict reads. On corpora of single changes to a valid metadata value of
 * each event type, each pair gives the same verdict and output, and the same
 * wire issues but for `message`.
 *
 * Declared differences, each recognized where it is allowed and counted:
 *
 * - **the object kind**: a value that is no object gets an issue of kind
 *   `loose_object`, fuz_schema's kind for the schema, where Zod's is
 *   `object`; its `expected` is `object` in both.
 * - **the email bound**, as in `admin_action_specs.differential.test.ts`: a
 *   `signup` `email` past `EMAIL_LENGTH_MAX` code units gets a `max_length`
 *   issue, where Zod gives its byte `check`.
 *
 * Insert-time validation is fail-open, so these differences reach only the
 * drift counter and its log line.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';
import { is_schema } from '@fuzdev/fuz_schema/schema.ts';

import { EMAIL_LENGTH_MAX, EMAIL_LENGTH_MESSAGE } from '#lib/primitive_schemas.ts';
import { API_TOKEN_ID_REGEX } from '#lib/auth/api_token.ts';
import { BUILTIN_CREDENTIAL_TYPES } from '#lib/auth/credential_type_schema.ts';
import { AUDIT_EVENT_TYPES, audit_metadata_schemas } from '#lib/auth/audit_log_schema.ts';
import {
	parse_any,
	to_wire_issues,
	type ValidationSchema,
	type WireIssue
} from '#lib/schema_issues.ts';
import { ZodEmail, ZodUuid } from '#lib/zod_schemas.ts';

// -- the Zod schemas the port replaced --------------------------------------

const zs = z.string();
const zu = ZodUuid;
const ZodSessionId = z.string().regex(/^[0-9a-f]{64}$/);
const ZodTokenId = z.string().regex(API_TOKEN_ID_REGEX);
const zcred = z.enum(BUILTIN_CREDENTIAL_TYPES).optional();
const zfail = { reason: zs.optional(), attempted_account_id: zu.optional() };
const zsnapshot = { username: zs.optional(), email: zs.nullable().optional(), ...zfail };
const zoffer = { offer_id: zu, role: zs, scope_id: zu.nullish() };

const ZOD_METADATA: Record<string, z.ZodType> = {
	login: z.looseObject({ username: zs }).nullable(),
	logout: z.null(),
	bootstrap: z.looseObject({ error: zs }).nullable(),
	signup: z.looseObject({
		username: zs,
		invite_id: zu.optional(),
		open_signup: z.boolean().optional(),
		reason: zs.optional(),
		email: ZodEmail.optional()
	}),
	password_change: z
		.looseObject({
			sessions_revoked: z.number().optional(),
			tokens_revoked: z.number().optional(),
			reason: z.enum(['concurrent_change']).optional(),
			credential_type: zcred
		})
		.nullable(),
	session_revoke: z.looseObject({ session_id: ZodSessionId, credential_type: zcred }),
	session_revoke_all: z.looseObject({
		count: z.number().optional(),
		...zfail,
		credential_type: zcred
	}),
	token_create: z.looseObject({ token_id: ZodTokenId, name: zs, credential_type: zcred }),
	token_revoke: z.looseObject({ token_id: ZodTokenId, credential_type: zcred }),
	token_revoke_all: z.looseObject({ count: z.number().optional(), ...zfail }),
	role_grant_create: z.looseObject({
		role: zs,
		role_grant_id: zu.optional(),
		scope_kind: zs.nullish(),
		scope_id: zu.nullish(),
		source_offer_id: zu.optional(),
		self_service: z.boolean().optional()
	}),
	role_grant_revoke: z.looseObject({
		role: zs,
		role_grant_id: zu,
		scope_id: zu.nullish(),
		reason: zs.optional(),
		self_service: z.boolean().optional()
	}),
	role_grant_offer_create: z.looseObject({
		offer_id: zu.optional(),
		role: zs,
		scope_id: zu.nullish(),
		to_account_id: zu
	}),
	role_grant_offer_accept: z.looseObject({
		offer_id: zu,
		role_grant_id: zu.optional(),
		role: zs,
		scope_id: zu.nullish(),
		reason: zs.optional()
	}),
	role_grant_offer_decline: z.looseObject({ ...zoffer, reason: zs.optional() }),
	role_grant_offer_retract: z.looseObject(zoffer),
	role_grant_offer_expire: z.looseObject(zoffer),
	role_grant_offer_supersede: z.looseObject({
		...zoffer,
		reason: z.enum([
			'sibling_accepted',
			'role_grant_revoked',
			'scope_destroyed',
			'account_deleted'
		]),
		cause_id: zu
	}),
	invite_create: z.looseObject({ invite_id: zu, email: zs.nullable(), username: zs.nullable() }),
	invite_delete: z.looseObject({ invite_id: zu }),
	account_delete: z.looseObject(zsnapshot),
	account_purge: z.looseObject(zsnapshot),
	account_undelete: z.looseObject(zsnapshot),
	actor_delete: z.looseObject({ name: zs.optional() }),
	actor_purge: z.looseObject({ name: zs.optional() }),
	actor_undelete: z.looseObject({ name: zs.optional() }),
	app_settings_update: z.looseObject({
		setting: zs,
		old_value: z.unknown(),
		new_value: z.unknown()
	}),
	db_admin_row_delete: z.looseObject({ table: zs, pk_column: zs, id: zs })
};

// -- corpora ----------------------------------------------------------------

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const HASH = 'a'.repeat(64);
const TOKEN = 'tok_abcdefghijkl';

/** A valid metadata value of each builtin event type. */
const BASES: Record<string, unknown> = {
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

/** What every field is set to, in turn: values of each kind a field here takes, and others. */
const POOL: ReadonlyArray<unknown> = [
	'alice',
	'',
	ID,
	ID.toUpperCase(),
	'not-a-uuid',
	HASH,
	'A'.repeat(64),
	TOKEN,
	'tok_short',
	'session',
	'api_token',
	'concurrent_change',
	'role_grant_revoked',
	'other',
	'user@example.com',
	'user@host',
	'a'.repeat(EMAIL_LENGTH_MAX + 1),
	0,
	3,
	1.5,
	NaN,
	true,
	false,
	null,
	undefined,
	{},
	[]
];

const MISSING = Symbol('missing');

/** Every single change to `base`, over the keys `schema` declares and one it doesn't. */
const corpus_of = (schema: ValidationSchema, base: unknown): Array<[string, unknown]> => {
	const out: Array<[string, unknown]> = [['base', base]];
	for (const value of [null, undefined, [], 'x', 1, {}]) {
		out.push([`whole: ${JSON.stringify(value)}`, value]);
	}
	if (base === null || typeof base !== 'object') return out;
	const keys = Object.keys((schema as z.ZodObject).shape ?? (schema as any).unwrap?.().shape ?? {});
	for (const key of [...keys, 'extra']) {
		for (const value of [...POOL, MISSING]) {
			const changed: Record<string, unknown> = { ...base };
			if (value === MISSING) delete changed[key];
			else changed[key] = value;
			out.push([`${key}: ${value === MISSING ? 'missing' : String(value).slice(0, 20)}`, changed]);
		}
	}
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

interface Counts {
	matched: number;
	refused: number;
	object_kind: number;
	email_bound: number;
}

const run = (
	schema: ValidationSchema,
	zod_schema: ValidationSchema,
	corpus: ReadonlyArray<[string, unknown]>
): Counts => {
	const counts: Counts = {
		matched: 0,
		refused: 0,
		object_kind: 0,
		email_bound: 0
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
		const zod_issues = zod.issues.map((issue) => {
			const key = issue.path.at(-1);
			const value = (input as Record<PropertyKey, unknown> | null)?.[key as PropertyKey];
			// declared: the object kind
			if (issue.kind === 'object' && issue.path.length === 0) {
				counts.object_kind++;
				return { ...issue, kind: 'loose_object' };
			}
			// declared: the email bound
			if (
				key === 'email' &&
				issue.kind === 'check' &&
				issue.message === EMAIL_LENGTH_MESSAGE &&
				typeof value === 'string' &&
				value.length > EMAIL_LENGTH_MAX
			) {
				counts.email_bound++;
				return { ...issue, kind: 'max_length', expected: `length <= ${EMAIL_LENGTH_MAX}` };
			}
			return issue;
		});
		assert.deepStrictEqual(fuz.issues.map(without_message), zod_issues.map(without_message), label);
	}
	return counts;
};

describe('the builtin audit metadata schemas agree with the Zod ones', () => {
	test('cover every builtin event type, each a fuz_schema schema', () => {
		assert.deepStrictEqual(Object.keys(audit_metadata_schemas), [...AUDIT_EVENT_TYPES]);
		assert.deepStrictEqual(Object.keys(ZOD_METADATA), [...AUDIT_EVENT_TYPES]);
		assert.deepStrictEqual(Object.keys(BASES), [...AUDIT_EVENT_TYPES]);
		for (const schema of Object.values(audit_metadata_schemas)) assert.ok(is_schema(schema));
	});

	test('each event type, but for the object kind and the email bound', () => {
		const totals: Counts = {
			matched: 0,
			refused: 0,
			object_kind: 0,
			email_bound: 0
		};
		for (const event_type of AUDIT_EVENT_TYPES) {
			const zod_schema = ZOD_METADATA[event_type]!;
			const counts = run(
				audit_metadata_schemas[event_type],
				zod_schema,
				corpus_of(zod_schema, BASES[event_type])
			);
			assert.ok(
				counts.matched >= 1 && counts.refused >= 4,
				`${event_type}: ${JSON.stringify(counts)}`
			);
			for (const key of Object.keys(totals) as Array<keyof Counts>) totals[key] += counts[key];
		}
		assert.ok(totals.matched >= 600 && totals.refused >= 600, JSON.stringify(totals));
		assert.ok(totals.object_kind >= 100, JSON.stringify(totals));
		assert.ok(totals.email_bound >= 1, JSON.stringify(totals));
	});

	test('unknown keys pass through, in either library', () => {
		const metadata = { username: 'alice', extra: { nested: [1] } };
		const fuz = parse_any(audit_metadata_schemas.login, metadata);
		const zod = parse_any(ZOD_METADATA.login!, metadata);
		assert.ok(fuz.ok && zod.ok);
		assert.deepStrictEqual(fuz.value, metadata);
		assert.deepStrictEqual(zod.value, metadata);
	});
});
