/**
 * `self_service_role_set`'s `@fuzdev/fuz_schema` schemas, held to the Zod
 * schemas they replaced, rebuilt here: the same verdict and output on a corpus
 * of inputs and of outputs, and the same wire issues but for `message`. The
 * surface entry is the Zod-era one as JSON, captured in
 * `fixtures/surface/self_service_role.json`, and the acting check still finds
 * the input's `acting`.
 *
 * Declared differences, both in the issues alone: a `role` both too long and
 * outside the grammar gets the length issue alone, where Zod added the
 * grammar issue after it, and each `message` is fuz_schema's text, the
 * `RoleName` custom messages behind the issue's path (`role: Role names
 * must be ...`) where Zod gave them bare.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { is_schema } from '@fuzdev/fuz_schema/schema.ts';
import { get_schema_entries } from '@fuzdev/fuz_schema/introspect.ts';

import {
	SelfServiceRoleSetInput,
	SelfServiceRoleSetOutput,
	self_service_role_set_action_spec
} from '#lib/auth/self_service_role_action_specs.ts';
import {
	ROLE_NAME_LENGTH_MAX,
	ROLE_NAME_LENGTH_MESSAGE,
	ROLE_NAME_PATTERN,
	ROLE_NAME_PATTERN_MESSAGE,
	RoleName as ZodRoleName
} from '#lib/auth/role_schema.ts';
import {
	ActingActor as ZodActingActor,
	assert_route_auth_acting_biconditional,
	input_schema_declares_acting
} from '#lib/http/auth_shape.ts';
import { ActingActor } from '#lib/primitive_schemas_fuz.ts';
import { generate_app_surface } from '#lib/http/surface.ts';
import { action_manifest_entry } from '#lib/testing/cross_backend/action_manifest.ts';
import { parse_any, to_wire_issues, type WireIssue } from '#lib/schema_issues.ts';

const SURFACE_FIXTURE_PATH = new URL('../fixtures/surface/self_service_role.json', import.meta.url);

/** The Zod input `self_service_role_set` declared before the port. */
const ZodInput = z.strictObject({
	role: ZodRoleName.meta({ description: 'Role to toggle. Must be in the configured allowlist.' }),
	enabled: z.boolean().meta({
		description:
			'Desired post-call state. `true` grants if not held; `false` revokes if held. Idempotent in both directions.'
	}),
	acting: ZodActingActor
});

/** The Zod output `self_service_role_set` declared before the port. */
const ZodOutput = z.strictObject({
	ok: z.literal(true),
	enabled: z.boolean(),
	changed: z.boolean()
});

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const LONG = 'a'.repeat(ROLE_NAME_LENGTH_MAX + 1);
const LONG_OFF_GRAMMAR = 'A'.repeat(ROLE_NAME_LENGTH_MAX + 1);

const INPUT_CORPUS: Array<[label: string, input: unknown]> = [
	['enable', { role: 'admin', enabled: true }],
	['disable', { role: 'admin', enabled: false }],
	['one letter', { role: 'a', enabled: true }],
	['at the cap', { role: 'a'.repeat(ROLE_NAME_LENGTH_MAX), enabled: true }],
	['with acting', { role: 'a_b', enabled: true, acting: ID }],
	['with acting uppercase', { role: 'a_b', enabled: true, acting: ID.toUpperCase() }],
	['with acting undefined', { role: 'a_b', enabled: true, acting: undefined }],
	['bad acting', { role: 'a_b', enabled: true, acting: 'not-a-uuid' }],
	['null acting', { role: 'a_b', enabled: true, acting: null }],
	['one past the cap', { role: LONG, enabled: true }],
	['one past the cap, off the grammar', { role: LONG_OFF_GRAMMAR, enabled: true }],
	['leading underscore', { role: '_admin', enabled: true }],
	['trailing underscore', { role: 'admin_', enabled: true }],
	['uppercase', { role: 'Admin', enabled: true }],
	['digit', { role: 'admin2', enabled: true }],
	['empty role', { role: '', enabled: true }],
	['Cyrillic a', { role: 'аdmin', enabled: true }],
	['number role', { role: 1, enabled: true }],
	['null role', { role: null, enabled: true }],
	['missing role', { enabled: true }],
	['missing enabled', { role: 'admin' }],
	['string enabled', { role: 'admin', enabled: 'true' }],
	['number enabled', { role: 'admin', enabled: 1 }],
	['null enabled', { role: 'admin', enabled: null }],
	['unknown key', { role: 'admin', enabled: true, extra: 1 }],
	['unknown key beside bad fields', { role: '_', enabled: 'no', extra: 1 }],
	['every field bad', { role: LONG_OFF_GRAMMAR, enabled: 0, acting: 'x', b: '', a: null }],
	['empty', {}],
	['array', [{ role: 'admin', enabled: true }]],
	['null', null],
	['undefined', undefined],
	['string', 'admin']
];

const OUTPUT_CORPUS: Array<[label: string, output: unknown]> = [
	['changed', { ok: true, enabled: true, changed: true }],
	['unchanged', { ok: true, enabled: false, changed: false }],
	['ok false', { ok: false, enabled: true, changed: true }],
	['ok string', { ok: 'true', enabled: true, changed: true }],
	['missing changed', { ok: true, enabled: true }],
	['missing ok', { enabled: true, changed: true }],
	['null enabled', { ok: true, enabled: null, changed: true }],
	['unknown key', { ok: true, enabled: true, changed: true, role: 'admin' }],
	['empty', {}],
	['null', null],
	['array', []]
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

const without_messages = (issues: Array<WireIssue>): Array<Omit<WireIssue, 'message'>> =>
	issues.map(({ message: _, ...rest }) => rest);

/**
 * The Zod issues less the one declared difference: a `role` both too long and
 * off the grammar loses its grammar issue, the second of its two.
 */
const declared_zod_issues = (input: unknown, issues: Array<WireIssue>): Array<WireIssue> => {
	const role = (input as { role?: unknown } | null)?.role;
	if (typeof role !== 'string' || role.length <= ROLE_NAME_LENGTH_MAX) return issues;
	if (ROLE_NAME_PATTERN.test(role)) return issues;
	const grammar = issues.findIndex((i) => i.kind === 'regex' && i.path[0] === 'role');
	assert.ok(grammar > 0 && issues[grammar - 1]!.kind === 'max_length');
	return issues.filter((_, i) => i !== grammar);
};

describe('self_service_role_set schemas', () => {
	test('are fuz_schema schemas', () => {
		assert.ok(is_schema(SelfServiceRoleSetInput));
		assert.ok(is_schema(SelfServiceRoleSetOutput));
		assert.strictEqual(self_service_role_set_action_spec.input, SelfServiceRoleSetInput);
		assert.strictEqual(self_service_role_set_action_spec.output, SelfServiceRoleSetOutput);
	});

	test('the input declares the twin ActingActor, so the acting check holds', () => {
		assert.strictEqual(get_schema_entries(SelfServiceRoleSetInput)?.acting, ActingActor);
		assert.ok(input_schema_declares_acting(SelfServiceRoleSetInput));
		assert.doesNotThrow(() =>
			assert_route_auth_acting_biconditional(
				self_service_role_set_action_spec.auth,
				{ input: SelfServiceRoleSetInput },
				'self_service_role_set'
			)
		);
	});

	test('the surface entry is the Zod-era one', () => {
		const surface = generate_app_surface({
			route_specs: [],
			middleware_specs: [],
			rpc_endpoints: [
				{
					path: '/api/rpc',
					actions: [{ spec: self_service_role_set_action_spec, handler: () => null }]
				}
			]
		});
		assert.deepStrictEqual(surface.diagnostics, []);
		const entry = surface.rpc_endpoints[0]!.methods[0]!;
		const expected = readFileSync(SURFACE_FIXTURE_PATH, 'utf8');
		assert.deepStrictEqual(entry, JSON.parse(expected));
		// equal as JSON, not byte for byte: fuz_schema writes the `acting` node's
		// `description` last, where Zod wrote it first; the `role` node's
		// keywords are in Zod's order
		assert.notStrictEqual(JSON.stringify(entry, null, '\t') + '\n', expected);
		const properties = (entry.input_schema as { properties: Record<string, object> }).properties;
		assert.deepStrictEqual(Object.keys(properties.role!), [
			'type',
			'maxLength',
			'pattern',
			'description'
		]);
		assert.deepStrictEqual(Object.keys(properties.acting!), [
			'type',
			'format',
			'pattern',
			'description'
		]);
	});

	test('the action manifest entry reads an object input', () => {
		assert.deepStrictEqual(action_manifest_entry(self_service_role_set_action_spec), {
			method: 'self_service_role_set',
			input: 'object',
			side_effects: true,
			account: 'required',
			actor: 'required',
			roles: [],
			credential_types: ['session'],
			rate_limit: 'account'
		});
	});

	describe('agree with the Zod schemas', () => {
		const run = (
			schema: Parameters<typeof parse_any>[0],
			zod_schema: Parameters<typeof parse_any>[0],
			corpus: Array<[label: string, input: unknown]>
		): { matched: number; refused: number } => {
			let matched = 0;
			let refused = 0;
			for (const [label, input] of corpus) {
				const fuz = outcome_of(schema, input);
				const zod = outcome_of(zod_schema, input);
				assert.strictEqual(fuz.ok, zod.ok, label);
				if (fuz.ok && zod.ok) {
					matched++;
					assert.deepStrictEqual(fuz.value, zod.value, label);
					continue;
				}
				assert.ok(!fuz.ok && !zod.ok);
				refused++;
				assert.deepStrictEqual(
					without_messages(fuz.issues),
					without_messages(declared_zod_issues(input, zod.issues)),
					label
				);
			}
			return { matched, refused };
		};

		test('on inputs', () => {
			const { matched, refused } = run(SelfServiceRoleSetInput, ZodInput, INPUT_CORPUS);
			assert.ok(matched >= 6, `${matched} matched`);
			assert.ok(refused >= 20, `${refused} refused`);
		});

		test('on outputs', () => {
			const { matched, refused } = run(SelfServiceRoleSetOutput, ZodOutput, OUTPUT_CORPUS);
			assert.strictEqual(matched, 2);
			assert.strictEqual(refused, OUTPUT_CORPUS.length - 2);
		});

		test('acting comes out lowercased, as under Zod', () => {
			const result = parse_any(SelfServiceRoleSetInput, {
				role: 'admin',
				enabled: true,
				acting: ID.toUpperCase()
			});
			assert.ok(result.ok);
			assert.deepStrictEqual<unknown>(result.value, { role: 'admin', enabled: true, acting: ID });
		});
	});

	test('an invalid input gets the Zod issues in fuz_schema’s words', () => {
		const cases: Array<[input: unknown, issues: Array<WireIssue>]> = [
			[
				{ role: LONG_OFF_GRAMMAR, enabled: 'yes', extra: 1 },
				[
					{
						kind: 'max_length',
						path: ['role'],
						expected: `length <= ${ROLE_NAME_LENGTH_MAX}`,
						received: 'string',
						message: `role: ${ROLE_NAME_LENGTH_MESSAGE}`
					},
					{
						kind: 'boolean',
						path: ['enabled'],
						expected: 'boolean',
						received: 'string',
						message: 'enabled: expected boolean, received string'
					},
					{
						kind: 'unknown_key',
						path: ['extra'],
						expected: 'no unknown keys',
						received: 'number',
						message: 'extra: expected no unknown keys, received number'
					}
				]
			],
			[
				{ role: '_admin', enabled: true },
				[
					{
						kind: 'regex',
						path: ['role'],
						expected: String(ROLE_NAME_PATTERN),
						received: 'string',
						message: `role: ${ROLE_NAME_PATTERN_MESSAGE}`
					}
				]
			],
			[
				{ enabled: true, acting: 'x' },
				[
					{
						kind: 'string',
						path: ['role'],
						expected: 'string',
						received: 'undefined',
						message: 'role: expected string, received undefined'
					},
					{
						kind: 'uuid',
						path: ['acting'],
						expected: 'uuid',
						received: 'string',
						message: 'acting: expected uuid, received string'
					}
				]
			]
		];
		for (const [input, issues] of cases) {
			const result = parse_any(SelfServiceRoleSetInput, input);
			assert.ok(!result.ok, JSON.stringify(input));
			assert.deepStrictEqual(to_wire_issues(result.issues, input), issues, JSON.stringify(input));
		}
	});
});
