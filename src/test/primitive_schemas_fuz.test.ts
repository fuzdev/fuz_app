/**
 * Tests for the fuz_schema twins in `primitive_schemas_fuz.ts`, held to the
 * Zod `Uuid`, `UuidWithDefault`, and `ActingActor` on one vector table, to
 * the Zod `bounded_string` on another, and to the Zod `Username` and `Email`
 * on a third: both libraries give every row the same verdict and output, and
 * `Username` and `Email` the same wire issues but for the declared ones.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { z } from 'zod';
import { get_meta } from '@fuzdev/fuz_schema/meta.ts';
import { is_schema, parse } from '@fuzdev/fuz_schema/schema.ts';
import { to_json_schema } from '@fuzdev/fuz_schema/json_schema.ts';

import {
	EMAIL_LENGTH_MAX,
	EMAIL_LENGTH_MESSAGE,
	Email as ZodEmail,
	USERNAME_LENGTH_MAX,
	USERNAME_LENGTH_MIN,
	Username as ZodUsername,
	Uuid as ZodUuid,
	UuidWithDefault as ZodUuidWithDefault,
	bounded_string as zod_bounded_string,
	type BoundedStringOptions
} from '#lib/primitive_schemas.ts';
import {
	ACTING_ACTOR_DESCRIPTION,
	ActingActor,
	Email,
	Username,
	Uuid,
	UuidWithDefault,
	bounded_string
} from '#lib/primitive_schemas_fuz.ts';
import { ActingActor as ZodActingActor } from '#lib/http/auth_shape.ts';
import { parse_any, to_wire_issues, type WireIssue } from '#lib/schema_issues.ts';

/** The shape `crypto.randomUUID()` produces — a lowercase version-4 UUID. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A row's result: the lowercased output, or `null` for a refusal. */
type Verdict = string | null;

/** One vector: the input and what both twins give for it. */
interface UuidVector {
	input: unknown;
	expected: Verdict;
}

const UUID_VECTORS: Record<string, UuidVector> = {
	'lowercase v4': {
		input: 'f81d4fae-7dec-41d0-a765-00a0c91e6bf6',
		expected: 'f81d4fae-7dec-41d0-a765-00a0c91e6bf6'
	},
	'uppercase v4': {
		input: 'F81D4FAE-7DEC-41D0-A765-00A0C91E6BF6',
		expected: 'f81d4fae-7dec-41d0-a765-00a0c91e6bf6'
	},
	'mixed case v1': {
		input: 'f81D4fae-7DEC-11d0-A765-00a0C91e6bf6',
		expected: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6'
	},
	'version 2': {
		input: '3f8a1c2e-1234-2abc-9def-0123456789ab',
		expected: '3f8a1c2e-1234-2abc-9def-0123456789ab'
	},
	'version 3': {
		input: '3f8a1c2e-1234-3abc-9def-0123456789ab',
		expected: '3f8a1c2e-1234-3abc-9def-0123456789ab'
	},
	'version 5': {
		input: '3f8a1c2e-1234-5abc-9def-0123456789ab',
		expected: '3f8a1c2e-1234-5abc-9def-0123456789ab'
	},
	'version 6': {
		input: '3f8a1c2e-1234-6abc-9def-0123456789ab',
		expected: '3f8a1c2e-1234-6abc-9def-0123456789ab'
	},
	'version 7': {
		input: '019a4f2e-1234-7abc-9def-0123456789ab',
		expected: '019a4f2e-1234-7abc-9def-0123456789ab'
	},
	'version 8': {
		input: '3f8a1c2e-1234-8abc-9def-0123456789ab',
		expected: '3f8a1c2e-1234-8abc-9def-0123456789ab'
	},
	'variant 8': {
		input: '3f8a1c2e-1234-4abc-8def-0123456789ab',
		expected: '3f8a1c2e-1234-4abc-8def-0123456789ab'
	},
	'variant a': {
		input: '3f8a1c2e-1234-4abc-adef-0123456789ab',
		expected: '3f8a1c2e-1234-4abc-adef-0123456789ab'
	},
	'uppercase variant A': {
		input: '3f8a1c2e-1234-4abc-Adef-0123456789ab',
		expected: '3f8a1c2e-1234-4abc-adef-0123456789ab'
	},
	'uppercase variant B': {
		input: '3f8a1c2e-1234-4abc-Bdef-0123456789ab',
		expected: '3f8a1c2e-1234-4abc-bdef-0123456789ab'
	},
	nil: {
		input: '00000000-0000-0000-0000-000000000000',
		expected: '00000000-0000-0000-0000-000000000000'
	},
	'lowercase max': {
		input: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
		expected: 'ffffffff-ffff-ffff-ffff-ffffffffffff'
	},
	'uppercase max': {
		input: 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
		expected: 'ffffffff-ffff-ffff-ffff-ffffffffffff'
	},
	'mixed case max': {
		input: 'ffffffff-FFFF-ffff-FFFF-ffffffffffff',
		expected: 'ffffffff-ffff-ffff-ffff-ffffffffffff'
	},
	'version 0': { input: '00000000-0000-0000-0000-000000000001', expected: null },
	'version 9': { input: '3f8a1c2e-1234-9abc-9def-0123456789ab', expected: null },
	'version a': { input: '3f8a1c2e-1234-aabc-9def-0123456789ab', expected: null },
	'version A': { input: '3f8a1c2e-1234-Aabc-9def-0123456789ab', expected: null },
	'variant 1': { input: '3f8a1c2e-1234-4abc-1def-0123456789ab', expected: null },
	'variant 7': { input: '3f8a1c2e-1234-4abc-7def-0123456789ab', expected: null },
	'variant c': { input: '3f8a1c2e-1234-4abc-cdef-0123456789ab', expected: null },
	'uppercase variant C': { input: '3f8a1c2e-1234-4abc-Cdef-0123456789ab', expected: null },
	'nil but one f': { input: 'f0000000-0000-0000-0000-000000000000', expected: null },
	'max but one 0': { input: 'ffffffff-ffff-ffff-ffff-fffffffffff0', expected: null },
	'max, one group short': { input: 'ffffffff-ffff-ffff-ffff-fffffffffff', expected: null },
	'all ones': { input: '11111111-1111-1111-1111-111111111111', expected: null },
	'no dashes': { input: '3f8a1c2e12344abc9def0123456789ab', expected: null },
	braced: { input: '{3f8a1c2e-1234-4abc-9def-0123456789ab}', expected: null },
	urn: { input: 'urn:uuid:3f8a1c2e-1234-4abc-9def-0123456789ab', expected: null },
	'non-hex digit': { input: 'g81d4fae-7dec-41d0-a765-00a0c91e6bf6', expected: null },
	'a trailing newline': { input: 'f81d4fae-7dec-41d0-a765-00a0c91e6bf6\n', expected: null },
	'not a uuid': { input: 'not-a-uuid', expected: null },
	empty: { input: '', expected: null },
	number: { input: 123, expected: null },
	null: { input: null, expected: null },
	undefined: { input: undefined, expected: null }
};

const run_fuz = (input: unknown): Verdict => {
	const result = parse(Uuid, input);
	return result.ok ? result.value : null;
};

const run_zod = (input: unknown): Verdict => {
	const result = ZodUuid.safeParse(input);
	return result.success ? result.data : null;
};

describe('fuz_schema Uuid', () => {
	for (const [name, { input, expected }] of Object.entries(UUID_VECTORS)) {
		test(`${name}: ${expected === null ? 'refused' : 'accepted, lowercased'}`, () => {
			assert.strictEqual(run_fuz(input), expected);
		});
	}

	test('the Zod Uuid gives every row the same verdict and output', () => {
		for (const [name, { input, expected }] of Object.entries(UUID_VECTORS)) {
			assert.strictEqual(run_zod(input), expected, name);
		}
	});

	test('its JSON Schema is the Zod Uuid’s, the pattern string included', () => {
		for (const io of ['input', 'output'] as const) {
			const fuz_json = to_json_schema(Uuid, { io });
			const zod_json = z.toJSONSchema(ZodUuid, { io });
			// the pattern strings are equal, which pins the Zod `Uuid`'s regex to
			// fuz_schema's `uuid` grammar
			assert.deepEqual<Record<string, unknown>>(fuz_json, zod_json, io);
			assert(typeof fuz_json.pattern === 'string');
			// and the pattern matches what the vectors say
			const regex = new RegExp(fuz_json.pattern);
			for (const [name, { input, expected }] of Object.entries(UUID_VECTORS)) {
				if (typeof input !== 'string') continue;
				assert.strictEqual(regex.test(input), expected !== null, `${io} ${name}`);
			}
		}
	});

	test('one Uuid type: either twin’s output is assignable to the other’s', () => {
		const parsed = parse(Uuid, 'f81d4fae-7dec-41d0-a765-00a0c91e6bf6');
		assert.ok(parsed.ok);
		const fuz_out: Uuid = parsed.value;
		const zod_out: ZodUuid = ZodUuid.parse('f81d4fae-7dec-41d0-a765-00a0c91e6bf6');
		const zod_from_fuz: ZodUuid = fuz_out;
		const fuz_from_zod: Uuid = zod_out;
		// a cast from a plain string keeps working
		const cast: ZodUuid = 'f81d4fae-7dec-41d0-a765-00a0c91e6bf6' as ZodUuid;
		assert.strictEqual(zod_from_fuz, fuz_from_zod);
		assert.strictEqual(cast, zod_out);
		// @ts-expect-error a plain string is not a Uuid
		const plain: ZodUuid = 'f81d4fae-7dec-41d0-a765-00a0c91e6bf6';
		assert.isString(plain);
	});
});

describe('fuz_schema UuidWithDefault', () => {
	test('generates a fresh v4 for undefined', () => {
		const a = parse(UuidWithDefault, undefined);
		const b = parse(UuidWithDefault, undefined);
		assert.ok(a.ok && b.ok);
		assert.match(a.value, UUID_V4);
		assert.notStrictEqual(a.value, b.value);
	});

	test('lowercases an explicit value and refuses an invalid one', () => {
		const result = parse(UuidWithDefault, 'F81D4FAE-7DEC-41D0-A765-00A0C91E6BF6');
		assert.ok(result.ok);
		assert.strictEqual(result.value, 'f81d4fae-7dec-41d0-a765-00a0c91e6bf6');
		assert.isFalse(parse(UuidWithDefault, 'nope').ok);
		assert.isFalse(ZodUuidWithDefault.safeParse('nope').success);
	});
});

describe('fuz_schema ActingActor', () => {
	test('is an optional Uuid', () => {
		assert.ok(is_schema(ActingActor));
		const absent = parse(ActingActor, undefined);
		assert.ok(absent.ok);
		assert.isUndefined(absent.value);
		const upper = parse(ActingActor, 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF');
		assert.ok(upper.ok);
		assert.strictEqual(upper.value, 'ffffffff-ffff-ffff-ffff-ffffffffffff');
		assert.strictEqual(
			ZodActingActor.parse('FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF'),
			'ffffffff-ffff-ffff-ffff-ffffffffffff'
		);
		assert.isFalse(parse(ActingActor, null).ok);
		assert.isFalse(parse(ActingActor, 'not-a-uuid').ok);
	});

	test('carries the Zod twin’s description', () => {
		assert.strictEqual(get_meta(ActingActor)?.description, ACTING_ACTOR_DESCRIPTION);
		assert.strictEqual(z.globalRegistry.get(ZodActingActor)?.description, ACTING_ACTOR_DESCRIPTION);
	});
});

/** U+1F600 — one code point, two UTF-16 code units. */
const ASTRAL = '\u{1F600}';

/** The bounds each row of `BOUNDED_STRING_VECTORS` runs under. */
const BOUNDS: Array<BoundedStringOptions> = [{ max: 8 }, { min: 4, max: 8 }, { min: 1, max: 1 }];

/** Strings around the bounds, ASCII and astral, and values that are no string. */
const BOUNDED_STRING_VECTORS: Array<unknown> = [
	'',
	'a',
	'aa',
	'aaaa',
	'a'.repeat(8),
	'a'.repeat(9),
	ASTRAL,
	ASTRAL.repeat(2),
	ASTRAL.repeat(4),
	ASTRAL.repeat(4) + 'a',
	ASTRAL.repeat(5),
	null,
	undefined,
	8,
	['a']
];

describe('fuz_schema bounded_string', () => {
	test('the Zod bounded_string gives every row the same verdict', () => {
		for (const options of BOUNDS) {
			const fuz = bounded_string(options);
			const zod = zod_bounded_string(options);
			for (const input of BOUNDED_STRING_VECTORS) {
				const label = `${JSON.stringify(options)} ${JSON.stringify(input)}`;
				const fuz_result = parse(fuz, input);
				assert.strictEqual(fuz_result.ok, zod.safeParse(input).success, label);
				if (fuz_result.ok) assert.strictEqual(fuz_result.value, input, label);
			}
		}
	});

	test('counts UTF-16 code units: astral at the cap passes, one unit past is refused', () => {
		const schema = bounded_string({ min: 4, max: 8 });
		assert.ok(parse(schema, ASTRAL.repeat(4)).ok);
		assert.ok(parse(schema, ASTRAL.repeat(2)).ok);
		const over = parse(schema, ASTRAL.repeat(4) + 'a');
		assert.ok(!over.ok);
		assert.deepStrictEqual(
			over.issues.map((i) => [i.kind, i.expected]),
			[['max_length', 'length <= 8']]
		);
		const under = parse(schema, ASTRAL);
		assert.ok(!under.ok);
		assert.deepStrictEqual(
			under.issues.map((i) => [i.kind, i.expected]),
			[['min_length', 'length >= 4']]
		);
	});

	test('its JSON Schema is the Zod bounded_string’s', () => {
		for (const options of BOUNDS) {
			assert.deepEqual<Record<string, unknown>>(
				to_json_schema(bounded_string(options)),
				z.toJSONSchema(zod_bounded_string(options)),
				JSON.stringify(options)
			);
		}
	});

	test('max_message replaces the over-max message only', () => {
		const schema = bounded_string({ min: 2, max: 4, max_message: 'too long' });
		const over = parse(schema, 'aaaaa');
		assert.ok(!over.ok);
		assert.strictEqual(over.issues[0]!.message, 'too long');
		const under = parse(schema, 'a');
		assert.ok(!under.ok);
		assert.isUndefined(under.issues[0]!.message);
	});
});

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

const USERNAME_VECTORS: Array<unknown> = [
	'alice',
	'Alice',
	'ALICE',
	'a1',
	'a-b_c',
	'abc',
	'a'.repeat(USERNAME_LENGTH_MAX),
	'a'.repeat(USERNAME_LENGTH_MAX + 1),
	'1'.repeat(USERNAME_LENGTH_MAX + 1),
	'ab',
	'a',
	'1',
	'',
	'1ab',
	'ab-',
	'a b',
	' alice',
	'al.ice',
	'al@ice',
	'аlice',
	ASTRAL.repeat(2),
	null,
	undefined,
	3,
	['alice']
];

describe('fuz_schema Username', () => {
	test('the Zod Username gives every row the same verdict, output and issues but one', () => {
		for (const input of USERNAME_VECTORS) {
			const label = JSON.stringify(input);
			const fuz = outcome_of(Username, input);
			const zod = outcome_of(ZodUsername, input);
			assert.strictEqual(fuz.ok, zod.ok, label);
			if (fuz.ok && zod.ok) {
				assert.strictEqual(fuz.value, zod.value, label);
				assert.strictEqual(fuz.value, (input as string).toLowerCase(), label);
				continue;
			}
			assert.ok(!fuz.ok && !zod.ok);
			// declared: a string too short or too long gets the length issue alone,
			// where Zod adds the grammar issue after it; and a value that is no
			// string the type issue alone, where the Zod `bounded_string`'s length
			// check still reads the `length` of an array, adding a `min_length`
			const zod_issues =
				zod.issues.length === 2 &&
				(fuz.issues[0]?.kind.endsWith('_length') ||
					(fuz.issues[0]?.kind === 'string' && zod.issues[1]!.kind === 'min_length'))
					? zod.issues.slice(0, 1)
					: zod.issues;
			assert.deepStrictEqual(
				fuz.issues.map(({ message: _, ...rest }) => rest),
				zod_issues.map(({ message: _, ...rest }) => rest),
				label
			);
		}
	});

	test('a short username gets one issue, where Zod gives two', () => {
		const fuz = outcome_of(Username, 'a');
		const zod = outcome_of(ZodUsername, 'a');
		assert.ok(!fuz.ok && !zod.ok);
		assert.deepStrictEqual(
			fuz.issues.map((i) => i.kind),
			['min_length']
		);
		assert.deepStrictEqual(
			zod.issues.map((i) => i.kind),
			['min_length', 'regex']
		);
		assert.strictEqual(fuz.issues[0]!.expected, `length >= ${USERNAME_LENGTH_MIN}`);
	});

	test('its JSON Schema is the Zod Username’s on the input side', () => {
		assert.deepEqual<Record<string, unknown>>(
			to_json_schema(Username, { io: 'input' }),
			z.toJSONSchema(ZodUsername, { io: 'input' })
		);
	});
});

const EMAIL_VECTORS: Array<unknown> = [
	'user@example.com',
	'User@Example.com',
	'user+tag@example.co.uk',
	'a@b.c',
	'a..b@c.d',
	'a@b..c',
	'a@.b.c',
	'a@b.c.',
	'user@.com',
	'user@com.',
	'user@host',
	'@example.com',
	'user@',
	'a@@b.c',
	'not-an-email',
	'',
	' user@example.com',
	'a\u0085b@c.d',
	'a\ufeffb@c.d',
	`${'a'.repeat(EMAIL_LENGTH_MAX - 12)}@example.com`,
	`${'a'.repeat(EMAIL_LENGTH_MAX - 11)}@example.com`,
	'a'.repeat(EMAIL_LENGTH_MAX + 1),
	`${'\u00fc'.repeat(121)}@example.com`,
	`${'\u00fc'.repeat(122)}@example.com`,
	`${ASTRAL.repeat(60)}@example.com`,
	`${ASTRAL.repeat(61)}@example.com`,
	null,
	undefined,
	1
];

describe('fuz_schema Email', () => {
	test('the Zod Email gives every row the same verdict, output and issues but one', () => {
		for (const input of EMAIL_VECTORS) {
			const label = JSON.stringify(input);
			const fuz = outcome_of(Email, input);
			const zod = outcome_of(ZodEmail, input);
			assert.strictEqual(fuz.ok, zod.ok, label);
			if (fuz.ok && zod.ok) {
				assert.strictEqual(fuz.value, input, label);
				assert.strictEqual(zod.value, input, label);
				continue;
			}
			assert.ok(!fuz.ok && !zod.ok);
			if (typeof input === 'string' && input.length > EMAIL_LENGTH_MAX) {
				// declared: past the bound in code units, the one length issue, a
				// `max_length` where Zod gives its byte `check`, after the grammar
				// issue when the string is off the grammar too
				assert.deepStrictEqual(fuz.issues, [
					{
						kind: 'max_length',
						path: [],
						expected: `length <= ${EMAIL_LENGTH_MAX}`,
						received: 'string',
						message: EMAIL_LENGTH_MESSAGE
					}
				]);
				assert.deepStrictEqual(zod.issues.at(-1), {
					kind: 'check',
					path: [],
					expected: 'check',
					received: 'string',
					message: EMAIL_LENGTH_MESSAGE
				});
				continue;
			}
			assert.deepStrictEqual(
				fuz.issues.map(({ message: _, ...rest }) => rest),
				zod.issues.map(({ message: _, ...rest }) => rest),
				label
			);
			// the byte bound's issue carries the Zod refine's message
			for (const [i, issue] of fuz.issues.entries()) {
				if (issue.kind === 'check') {
					assert.strictEqual(issue.message, EMAIL_LENGTH_MESSAGE, label);
					assert.strictEqual(zod.issues[i]!.message, EMAIL_LENGTH_MESSAGE, label);
				}
			}
		}
	});

	test('bounds UTF-8 bytes: a multibyte address within the units but past the bytes fails the check', () => {
		const at = `${'\u00fc'.repeat(121)}@example.com`;
		const over = `${'\u00fc'.repeat(122)}@example.com`;
		assert.ok(over.length <= EMAIL_LENGTH_MAX);
		assert.ok(parse(Email, at).ok);
		const result = outcome_of(Email, over);
		assert.ok(!result.ok);
		assert.deepStrictEqual(
			result.issues.map((i) => [i.kind, i.message]),
			[['check', EMAIL_LENGTH_MESSAGE]]
		);
	});

	test('its JSON Schema is the Zod Email’s with the bound as maxLength', () => {
		const fuz_json = to_json_schema(Email, { io: 'input', unrepresentable: 'any' });
		const zod_json = z.toJSONSchema(ZodEmail, { io: 'input' });
		assert.deepEqual<Record<string, unknown>>(fuz_json, {
			...zod_json,
			maxLength: EMAIL_LENGTH_MAX
		});
		assert.throws(() => to_json_schema(Email, { io: 'input' }), /check/);
	});
});
