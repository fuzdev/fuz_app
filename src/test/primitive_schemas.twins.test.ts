/**
 * Tests for the fuz_schema primitives of `primitive_schemas.ts` on vector
 * tables. Each table's expected column was frozen from the Zod forms these
 * schemas replaced: the answer each gave for every row, written as data
 * (`ZOD_*_ANSWERS`, `ZOD_BOUNDED_VERDICTS`, `ZOD_JSON`), with the rows where
 * the fuz_schema form answers differently listed beside them
 * (`USERNAME_DECLARED`, `EMAIL_DECLARED`). `UsernameCanonical` and
 * `Timestamp` are held to their grammars.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { get_meta } from '@fuzdev/fuz_schema/meta.ts';
import { is_schema, parse } from '@fuzdev/fuz_schema/schema.ts';
import { to_json_schema } from '@fuzdev/fuz_schema/json_schema.ts';

import {
	ACTING_ACTOR_DESCRIPTION,
	ActingActor,
	BLAKE3_HASH_MESSAGE,
	Blake3Hash,
	EMAIL_LENGTH_MAX,
	EMAIL_LENGTH_MESSAGE,
	Email,
	Timestamp,
	USERNAME_CANONICAL_REGEX,
	USERNAME_LENGTH_MAX,
	USERNAME_LENGTH_MIN,
	USERNAME_REGEX,
	Username,
	UsernameCanonical,
	Uuid,
	UuidWithDefault,
	bounded_string,
	type BoundedStringOptions
} from '#lib/primitive_schemas.ts';
import { parse_any, to_wire_issues, type WireIssue } from '#lib/schema_issues.ts';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A row's result: the lowercased output, or `null` for a refusal. */
type Verdict = string | null;

/** One vector: the input and what the schema gives for it (frozen from the Zod form). */
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

describe('fuz_schema Uuid', () => {
	for (const [name, { input, expected }] of Object.entries(UUID_VECTORS)) {
		test(`${name}: ${expected === null ? 'refused' : 'accepted, lowercased'}`, () => {
			assert.strictEqual(run_fuz(input), expected);
		});
	}

	test('its JSON Schema is the one the Zod form wrote, the pattern string included', () => {
		for (const io of ['input', 'output'] as const) {
			const fuz_json = to_json_schema(Uuid, { io });
			// the pattern strings are equal, which pins the grammar
			assert.deepEqual<Record<string, unknown>>(fuz_json, ZOD_JSON.uuid, io);
			assert(typeof fuz_json.pattern === 'string');
			// and the pattern matches what the vectors say
			const regex = new RegExp(fuz_json.pattern);
			for (const [name, { input, expected }] of Object.entries(UUID_VECTORS)) {
				if (typeof input !== 'string') continue;
				assert.strictEqual(regex.test(input), expected !== null, `${io} ${name}`);
			}
		}
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
		assert.isFalse(parse(ActingActor, null).ok);
		assert.isFalse(parse(ActingActor, 'not-a-uuid').ok);
	});

	test('carries its description', () => {
		assert.strictEqual(get_meta(ActingActor)?.description, ACTING_ACTOR_DESCRIPTION);
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
	test('gives every row the verdict the Zod form gave, and the input as output', () => {
		for (const [b, options] of BOUNDS.entries()) {
			const fuz = bounded_string(options);
			for (const [i, input] of BOUNDED_STRING_VECTORS.entries()) {
				const label = `${JSON.stringify(options)} ${JSON.stringify(input)}`;
				const fuz_result = parse(fuz, input);
				assert.strictEqual(fuz_result.ok, ZOD_BOUNDED_VERDICTS[b]![i] === '1', label);
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

	test('its JSON Schema is the one the Zod form wrote', () => {
		for (const [b, options] of BOUNDS.entries()) {
			assert.deepEqual<Record<string, unknown>>(
				to_json_schema(bounded_string(options)),
				ZOD_JSON.bounded[b]!,
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

/** A refusal as `[kind, expected, received]` per issue; `'accepted'` otherwise. */
type Answer = 'accepted' | Array<[string, string, string]>;

const USERNAME_GRAMMAR = '/^[a-zA-Z][0-9a-zA-Z_-]*[0-9a-zA-Z]$/';
const EMAIL_GRAMMAR = '/^[^\\s\\u0085@]+@[^\\s\\u0085@.]+\\.[^\\s\\u0085@]*[^\\s\\u0085@.]$/';
const BLAKE3_GRAMMAR = '/^[0-9a-f]{64}$/';

/** What the earlier Zod forms answered for each row of `USERNAME_VECTORS`, in order. */
const ZOD_USERNAME_ANSWERS: Array<Answer> = [
	'accepted',
	'accepted',
	'accepted',
	[['min_length', 'length >= 3', 'string']],
	'accepted',
	'accepted',
	'accepted',
	[['max_length', 'length <= 39', 'string']],
	[
		['max_length', 'length <= 39', 'string'],
		['regex', USERNAME_GRAMMAR, 'string']
	],
	[['min_length', 'length >= 3', 'string']],
	[
		['min_length', 'length >= 3', 'string'],
		['regex', USERNAME_GRAMMAR, 'string']
	],
	[
		['min_length', 'length >= 3', 'string'],
		['regex', USERNAME_GRAMMAR, 'string']
	],
	[
		['min_length', 'length >= 3', 'string'],
		['regex', USERNAME_GRAMMAR, 'string']
	],
	[['regex', USERNAME_GRAMMAR, 'string']],
	[['regex', USERNAME_GRAMMAR, 'string']],
	[['regex', USERNAME_GRAMMAR, 'string']],
	[['regex', USERNAME_GRAMMAR, 'string']],
	[['regex', USERNAME_GRAMMAR, 'string']],
	[['regex', USERNAME_GRAMMAR, 'string']],
	[['regex', USERNAME_GRAMMAR, 'string']],
	[['regex', USERNAME_GRAMMAR, 'string']],
	[['string', 'string', 'null']],
	[['string', 'string', 'undefined']],
	[['string', 'string', 'number']],
	[
		['string', 'string', 'array'],
		['min_length', 'length >= 3', 'array']
	]
];

/** The rows where `Username` answers differently, by index: a length issue alone. */
const USERNAME_DECLARED: Record<number, Answer> = {
	8: [['max_length', 'length <= 39', 'string']],
	10: [['min_length', 'length >= 3', 'string']],
	11: [['min_length', 'length >= 3', 'string']],
	12: [['min_length', 'length >= 3', 'string']],
	24: [['string', 'string', 'array']]
};

/** What the earlier Zod form answered for each row of `EMAIL_VECTORS`, in order. */
const ZOD_EMAIL_ANSWERS: Array<Answer> = [
	'accepted',
	'accepted',
	'accepted',
	'accepted',
	'accepted',
	'accepted',
	[['regex', EMAIL_GRAMMAR, 'string']],
	[['regex', EMAIL_GRAMMAR, 'string']],
	[['regex', EMAIL_GRAMMAR, 'string']],
	[['regex', EMAIL_GRAMMAR, 'string']],
	[['regex', EMAIL_GRAMMAR, 'string']],
	[['regex', EMAIL_GRAMMAR, 'string']],
	[['regex', EMAIL_GRAMMAR, 'string']],
	[['regex', EMAIL_GRAMMAR, 'string']],
	[['regex', EMAIL_GRAMMAR, 'string']],
	[['regex', EMAIL_GRAMMAR, 'string']],
	[['regex', EMAIL_GRAMMAR, 'string']],
	[['regex', EMAIL_GRAMMAR, 'string']],
	[['regex', EMAIL_GRAMMAR, 'string']],
	'accepted',
	[['check', 'check', 'string']],
	[['check', 'check', 'string']],
	'accepted',
	[['check', 'check', 'string']],
	'accepted',
	[['check', 'check', 'string']],
	[['string', 'string', 'null']],
	[['string', 'string', 'undefined']],
	[['string', 'string', 'number']]
];

/** The rows where `Email` answers differently, by index: the bound in code units. */
const EMAIL_DECLARED: Record<number, Answer> = {
	20: [['max_length', 'length <= 254', 'string']],
	21: [['max_length', 'length <= 254', 'string']]
};

/** What the earlier Zod `Blake3Hash` answered for each row of `BLAKE3_VECTORS`, in order. */
const ZOD_BLAKE3_ANSWERS: Array<Answer> = [
	'accepted',
	'accepted',
	[['regex', BLAKE3_GRAMMAR, 'string']],
	[['regex', BLAKE3_GRAMMAR, 'string']],
	[['regex', BLAKE3_GRAMMAR, 'string']],
	[['regex', BLAKE3_GRAMMAR, 'string']],
	[['regex', BLAKE3_GRAMMAR, 'string']],
	[['regex', BLAKE3_GRAMMAR, 'string']],
	[['string', 'string', 'number']],
	[['string', 'string', 'null']]
];

/** The earlier Zod `bounded_string`'s verdicts, per bounds, one digit per row of `BOUNDED_STRING_VECTORS`. */
const ZOD_BOUNDED_VERDICTS = [
	'111110111000000', // {"max": 8}
	'000110011000000', // {"min": 4, "max": 8}
	'010000000000000' // {"min": 1, "max": 1}
];

/** The JSON Schemas the earlier Zod forms wrote. */
const ZOD_JSON = {
	uuid: {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'string',
		format: 'uuid',
		pattern:
			'^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$'
	},
	bounded: [
		{
			$schema: 'https://json-schema.org/draft/2020-12/schema',
			type: 'string',
			maxLength: 8
		},
		{
			$schema: 'https://json-schema.org/draft/2020-12/schema',
			type: 'string',
			minLength: 4,
			maxLength: 8
		},
		{
			$schema: 'https://json-schema.org/draft/2020-12/schema',
			type: 'string',
			minLength: 1,
			maxLength: 1
		}
	],
	username: {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'string',
		minLength: 3,
		maxLength: 39,
		pattern: '^[a-zA-Z][0-9a-zA-Z_-]*[0-9a-zA-Z]$'
	},
	email: {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'string',
		pattern: '^[^\\s\\u0085@]+@[^\\s\\u0085@.]+\\.[^\\s\\u0085@]*[^\\s\\u0085@.]$'
	},
	blake3: {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'string',
		pattern: '^[0-9a-f]{64}$'
	}
} as const;

/** Asserts a parse gave an answer: accepted with `value`, or the refusal's issues. */
const assert_answer = (
	schema: Parameters<typeof parse_any>[0],
	input: unknown,
	answer: Answer,
	value: unknown,
	label: string
): void => {
	const result = outcome_of(schema, input);
	if (answer === 'accepted') {
		assert.ok(result.ok, label);
		assert.strictEqual(result.value, value, label);
		return;
	}
	assert.ok(!result.ok, label);
	assert.deepStrictEqual(
		result.issues.map((i) => [i.kind, i.expected, i.received]),
		answer,
		label
	);
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
	test('gives every row the answer the Zod form gave, but for the declared rows', () => {
		let agree = 0;
		for (const [i, input] of USERNAME_VECTORS.entries()) {
			const label = JSON.stringify(input);
			const declared = USERNAME_DECLARED[i];
			const value = typeof input === 'string' ? input.toLowerCase() : undefined;
			assert_answer(Username, input, declared ?? ZOD_USERNAME_ANSWERS[i]!, value, label);
			if (!declared) agree++;
		}
		// a string too short or too long gets the length issue alone, where Zod
		// added the grammar issue after it; a value that is no string gets the
		// type issue alone, where Zod's length check still read an array
		assert.strictEqual(Object.keys(USERNAME_DECLARED).length, 5);
		assert.strictEqual(agree, USERNAME_VECTORS.length - 5);
	});

	test('a short username gets one issue, where Zod gave two', () => {
		const result = outcome_of(Username, 'a');
		assert.ok(!result.ok);
		assert.deepStrictEqual(
			result.issues.map((i) => i.kind),
			['min_length']
		);
		const zod_answer = ZOD_USERNAME_ANSWERS[USERNAME_VECTORS.indexOf('a')]!;
		assert.ok(zod_answer !== 'accepted');
		assert.deepStrictEqual(
			zod_answer.map((i) => i[0]),
			['min_length', 'regex']
		);
		assert.strictEqual(result.issues[0]!.expected, `length >= ${USERNAME_LENGTH_MIN}`);
	});

	test('its JSON Schema is the one the Zod form wrote on the input side', () => {
		assert.deepEqual<Record<string, unknown>>(
			to_json_schema(Username, { io: 'input' }),
			ZOD_JSON.username
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
	test('gives every row the answer the Zod form gave, but for the declared rows', () => {
		for (const [i, input] of EMAIL_VECTORS.entries()) {
			const declared = EMAIL_DECLARED[i];
			assert_answer(Email, input, declared ?? ZOD_EMAIL_ANSWERS[i]!, input, JSON.stringify(input));
			// declared: past the bound in code units, the one length issue, a
			// `max_length` where Zod gave its byte `check`
			if (declared) {
				assert.ok(typeof input === 'string' && input.length > EMAIL_LENGTH_MAX);
				const result = outcome_of(Email, input);
				assert.ok(!result.ok);
				assert.deepStrictEqual(result.issues, [
					{
						kind: 'max_length',
						path: [],
						expected: `length <= ${EMAIL_LENGTH_MAX}`,
						received: 'string',
						message: EMAIL_LENGTH_MESSAGE
					}
				]);
			}
		}
		assert.strictEqual(Object.keys(EMAIL_DECLARED).length, 2);
	});

	test('the byte bound’s issue carries its message', () => {
		for (const [i, input] of EMAIL_VECTORS.entries()) {
			const answer = ZOD_EMAIL_ANSWERS[i]!;
			if (answer === 'accepted' || answer[0]![0] !== 'check' || EMAIL_DECLARED[i]) continue;
			const result = outcome_of(Email, input);
			assert.ok(!result.ok);
			assert.strictEqual(
				result.issues.find((issue) => issue.kind === 'check')?.message,
				EMAIL_LENGTH_MESSAGE
			);
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

	test('its JSON Schema is the one the Zod form wrote, with the bound as maxLength', () => {
		const fuz_json = to_json_schema(Email, { io: 'input', unrepresentable: 'any' });
		assert.deepEqual<Record<string, unknown>>(fuz_json, {
			...ZOD_JSON.email,
			maxLength: EMAIL_LENGTH_MAX
		});
		assert.throws(() => to_json_schema(Email, { io: 'input' }), /check/);
	});
});

const BLAKE3_VECTORS: ReadonlyArray<unknown> = [
	'a'.repeat(64),
	'0123456789abcdef'.repeat(4),
	'A'.repeat(64),
	'a'.repeat(63),
	'a'.repeat(65),
	'g'.repeat(64),
	` ${'a'.repeat(64)}`,
	'',
	1,
	null
];

describe('fuz_schema Blake3Hash', () => {
	test('gives every row the answer the earlier Zod form gave, and its message', () => {
		for (const [i, input] of BLAKE3_VECTORS.entries()) {
			assert_answer(Blake3Hash, input, ZOD_BLAKE3_ANSWERS[i]!, input, String(input));
			if (typeof input === 'string') {
				const result = outcome_of(Blake3Hash, input);
				if (!result.ok) {
					assert.deepStrictEqual(
						result.issues.map((issue) => issue.message),
						[BLAKE3_HASH_MESSAGE]
					);
				}
			}
		}
	});

	test('its JSON Schema is the one the Zod form wrote', () => {
		assert.deepEqual<Record<string, unknown>>(
			to_json_schema(Blake3Hash, { io: 'output' }),
			ZOD_JSON.blake3
		);
	});
});

describe('UsernameCanonical', () => {
	test('takes what the Zod Username output, and refuses a username in another case', () => {
		// the Zod Username answered each of these: the same value, its
		// lowercase, or a refusal (frozen)
		for (const input of ['alice', 'ab1', 'a-b_c', 'a'.repeat(USERNAME_LENGTH_MAX)]) {
			assert.ok(parse(UsernameCanonical, input).ok, input);
		}
		for (const input of ['Alice', 'ALICE', 'aB1']) {
			const result = outcome_of(UsernameCanonical, input);
			assert.ok(!result.ok, input);
			assert.deepStrictEqual(
				result.issues.map((i) => [i.kind, i.expected]),
				[['regex', String(USERNAME_CANONICAL_REGEX)]]
			);
		}
		for (const input of ['ab', 'a'.repeat(USERNAME_LENGTH_MAX + 1), '1ab', 'ab-', '', 1, null]) {
			assert.ok(!parse(UsernameCanonical, input).ok, String(input));
		}
	});

	test('its grammar is USERNAME_REGEX in lowercase', () => {
		assert.strictEqual(
			USERNAME_CANONICAL_REGEX.source,
			USERNAME_REGEX.source.replaceAll('a-zA-Z', 'a-z')
		);
	});

	test('its JSON Schema has the bounds and the lowercase grammar', () => {
		const { $schema: _, ...json } = to_json_schema(UsernameCanonical, { io: 'output' });
		assert.deepEqual<Record<string, unknown>>(json, {
			type: 'string',
			minLength: USERNAME_LENGTH_MIN,
			maxLength: USERNAME_LENGTH_MAX,
			pattern: USERNAME_CANONICAL_REGEX.source
		});
	});
});

describe('Timestamp', () => {
	test('takes both spines’ timestamps and a toISOString stamp, and refuses other forms', () => {
		for (const input of [
			'2026-11-05T12:34:56Z',
			new Date(0).toISOString(),
			'2024-02-29T23:59:59.123456789Z'
		]) {
			assert.ok(parse(Timestamp, input).ok, input);
		}
		for (const input of [
			'2026-11-05T12:34:56+00:00',
			'2026-11-05 12:34:56+00',
			'2026-11-05T12:34Z',
			'2026-02-30T00:00:00Z',
			'10000-01-01T00:00:00Z',
			'',
			0,
			null
		]) {
			assert.ok(!parse(Timestamp, input).ok, String(input));
		}
	});
});
