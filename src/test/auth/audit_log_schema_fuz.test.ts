/**
 * The `@fuzdev/fuz_schema` twins of `auth/audit_log_schema_fuz.ts`, held to
 * the Zod `AuditEventTypeName` and `AuditOutcome`: on one corpus each, the
 * same verdict, the same output, and the same wire issues, `message` included
 * where Zod's is one of the custom messages. Two differences are declared for
 * `AuditEventTypeName`: a string both too long and off the grammar gets the
 * length issue alone, where Zod adds the grammar issue after it, and a value
 * that is no string gets fuz_schema's message.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';
import { is_schema } from '@fuzdev/fuz_schema/schema.ts';
import { to_json_schema } from '@fuzdev/fuz_schema/json_schema.ts';

import {
	AuditEventTypeName as ZodAuditEventTypeName,
	AuditOutcome as ZodAuditOutcome
} from '#lib/auth/audit_log_schema.ts';
import {
	AUDIT_EVENT_TYPE_NAME_LENGTH_MESSAGE,
	AUDIT_EVENT_TYPE_NAME_PATTERN_MESSAGE,
	AUDIT_EVENT_TYPE_NAME_REGEX,
	AuditEventTypeName,
	AuditOutcome
} from '#lib/auth/audit_log_schema_fuz.ts';
import { parse_any, to_wire_issues, type WireIssue } from '#lib/schema_issues.ts';
import { NAME_LENGTH_MAX } from '#lib/auth/name_schema.ts';

/** Names of the grammar and around it, and values that are no string. */
const EVENT_TYPE_CORPUS: Array<unknown> = [
	'login',
	'role_grant_create',
	'a',
	'A',
	'app.thing/created-v2',
	'a.b',
	'a/b',
	'a-b',
	'a_',
	'a'.repeat(NAME_LENGTH_MAX),
	'a'.repeat(NAME_LENGTH_MAX + 1),
	'1'.repeat(NAME_LENGTH_MAX + 1),
	'_'.repeat(NAME_LENGTH_MAX + 1),
	'',
	'1login',
	'_login',
	'.login',
	'log in',
	'login\n',
	'lögin',
	'\u{1d41a}',
	null,
	undefined,
	1,
	true,
	['login'],
	{}
];

const OUTCOME_CORPUS: Array<unknown> = [
	'success',
	'failure',
	'Success',
	'',
	'maybe',
	' success',
	null,
	undefined,
	0,
	['success']
];

/** What a parse gave: its output, or its wire issues. */
const outcome_of = (
	schema: Parameters<typeof parse_any>[0],
	input: unknown
): { ok: true; value: unknown } | { ok: false; issues: Array<WireIssue> } => {
	const result = parse_any(schema, input);
	return result.ok
		? { ok: true, value: result.value }
		: { ok: false, issues: to_wire_issues(result.issues, input) };
};

const CUSTOM_MESSAGES: ReadonlyArray<string> = [
	AUDIT_EVENT_TYPE_NAME_LENGTH_MESSAGE,
	AUDIT_EVENT_TYPE_NAME_PATTERN_MESSAGE
];

describe('fuz_schema AuditEventTypeName', () => {
	test('is a fuz_schema schema', () => {
		assert.ok(is_schema(AuditEventTypeName));
	});

	test('keeps the Zod messages', () => {
		assert.strictEqual(AUDIT_EVENT_TYPE_NAME_LENGTH_MESSAGE, 'must be at most 64 characters');
		assert.strictEqual(
			AUDIT_EVENT_TYPE_NAME_PATTERN_MESSAGE,
			'must start with a letter; only letters, digits, _ . / - allowed'
		);
	});

	test('agrees with the Zod AuditEventTypeName on every row but the declared differences', () => {
		let matched = 0;
		let custom = 0;
		let declared = 0;
		for (const input of EVENT_TYPE_CORPUS) {
			const label = JSON.stringify(input) ?? String(input);
			const fuz = outcome_of(AuditEventTypeName, input);
			const zod = outcome_of(ZodAuditEventTypeName, input);
			assert.strictEqual(fuz.ok, zod.ok, label);
			if (fuz.ok && zod.ok) {
				assert.strictEqual(fuz.value, input, label);
				assert.strictEqual(zod.value, input, label);
				matched++;
				continue;
			}
			assert.ok(!fuz.ok && !zod.ok);
			const too_long_off_grammar =
				typeof input === 'string' &&
				input.length > NAME_LENGTH_MAX &&
				!AUDIT_EVENT_TYPE_NAME_REGEX.test(input);
			// declared: the one length issue, as fuz_schema's `pipe` stops at its
			// first failing step
			const zod_issues = too_long_off_grammar ? zod.issues.slice(0, 1) : zod.issues;
			if (too_long_off_grammar) {
				declared++;
				assert.deepStrictEqual(
					zod.issues.map((i) => i.kind),
					['max_length', 'regex'],
					label
				);
			}
			assert.strictEqual(fuz.issues.length, zod_issues.length, label);
			for (let i = 0; i < fuz.issues.length; i++) {
				const { message: fuz_message, ...fuz_rest } = fuz.issues[i]!;
				const { message: zod_message, ...zod_rest } = zod_issues[i]!;
				assert.deepStrictEqual(fuz_rest, zod_rest, label);
				if (CUSTOM_MESSAGES.includes(zod_message)) {
					custom++;
					assert.strictEqual(fuz_message, zod_message, label);
				} else {
					// declared: a value that is no string gets fuz_schema's message
					assert.notStrictEqual(typeof input, 'string', label);
					assert.strictEqual(fuz_message, `expected string, received ${fuz_rest.received}`);
				}
			}
		}
		assert.ok(matched >= 8, `${matched} matched`);
		assert.ok(custom >= 10, `${custom} custom messages`);
		assert.ok(declared >= 2, `${declared} too long and off the grammar`);
	});

	test('its JSON Schema is the Zod AuditEventTypeName’s, byte for byte', () => {
		assert.strictEqual(
			JSON.stringify(to_json_schema(AuditEventTypeName)),
			JSON.stringify(z.toJSONSchema(ZodAuditEventTypeName))
		);
	});
});

describe('fuz_schema AuditOutcome', () => {
	test('agrees with the Zod AuditOutcome on every row, its issues but for message', () => {
		for (const input of OUTCOME_CORPUS) {
			const label = JSON.stringify(input) ?? String(input);
			const fuz = outcome_of(AuditOutcome, input);
			const zod = outcome_of(ZodAuditOutcome, input);
			assert.strictEqual(fuz.ok, zod.ok, label);
			if (fuz.ok && zod.ok) {
				assert.strictEqual(fuz.value, zod.value, label);
				continue;
			}
			assert.ok(!fuz.ok && !zod.ok);
			assert.deepStrictEqual(
				fuz.issues.map(({ message: _, ...rest }) => rest),
				zod.issues.map(({ message: _, ...rest }) => rest),
				label
			);
		}
	});

	test('its JSON Schema is the Zod AuditOutcome’s, byte for byte', () => {
		assert.strictEqual(
			JSON.stringify(to_json_schema(AuditOutcome)),
			JSON.stringify(z.toJSONSchema(ZodAuditOutcome))
		);
	});
});
