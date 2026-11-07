/**
 * `self_service_role_set`'s schemas: their verdict and output on a corpus of
 * inputs and of outputs, and the wire issues an invalid input gets. The
 * surface entry matches `fixtures/surface/self_service_role.json` as JSON,
 * and the acting check still finds the input's `acting`.
 *
 * A `role` both too long and outside the grammar gets the length issue alone,
 * and each `message` carries the `RoleName` custom messages behind the
 * issue's path (`role: Role names must be ...`).
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { readFileSync } from 'node:fs';
import { is_schema, parse } from '@fuzdev/fuz_schema/schema.ts';
import { get_schema_entries } from '@fuzdev/fuz_schema/introspect.ts';

import {
	SelfServiceRoleSetInput,
	SelfServiceRoleSetOutput,
	self_service_role_set_action_spec
} from '#lib/auth/self_service_role_action_specs.ts';
import { ROLE_NAME_LENGTH_MESSAGE, ROLE_NAME_PATTERN_MESSAGE } from '#lib/auth/role_schema.ts';
import {
	assert_route_auth_acting_biconditional,
	input_schema_declares_acting
} from '#lib/http/auth_shape.ts';
import { ActingActor } from '#lib/primitive_schemas.ts';
import { generate_app_surface } from '#lib/http/surface.ts';
import { action_manifest_entry } from '#lib/testing/cross_backend/action_manifest.ts';
import { to_wire_issues, type WireIssue } from '#lib/schema_issues.ts';
import { NAME_LENGTH_MAX, NAME_REGEX } from '#lib/auth/name_schema.ts';

const SURFACE_FIXTURE_PATH = new URL('../fixtures/surface/self_service_role.json', import.meta.url);

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const LONG = 'a'.repeat(NAME_LENGTH_MAX + 1);
const LONG_OFF_GRAMMAR = 'A'.repeat(NAME_LENGTH_MAX + 1);

const INPUT_CORPUS: Array<[label: string, input: unknown]> = [
	['enable', { role: 'admin', enabled: true }],
	['disable', { role: 'admin', enabled: false }],
	['one letter', { role: 'a', enabled: true }],
	['at the cap', { role: 'a'.repeat(NAME_LENGTH_MAX), enabled: true }],
	['with acting', { role: 'a_b', enabled: true, acting: ID }],
	['with acting uppercase', { role: 'a_b', enabled: true, acting: ID.toUpperCase() }],
	['with acting undefined', { role: 'a_b', enabled: true, acting: undefined }],
	['bad acting', { role: 'a_b', enabled: true, acting: 'not-a-uuid' }],
	['null acting', { role: 'a_b', enabled: true, acting: null }],
	['one past the cap', { role: LONG, enabled: true }],
	['one past the cap, off the grammar', { role: LONG_OFF_GRAMMAR, enabled: true }],
	['leading underscore', { role: '_admin', enabled: true }],
	['trailing underscore', { role: 'admin_', enabled: true }],
	['double underscore', { role: 'ad__min', enabled: true }],
	['triple underscore', { role: 'ad___min', enabled: true }],
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

	test('the surface entry is the captured one as JSON', () => {
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
		// equal as JSON, not byte for byte: the `acting` node's `description` is
		// written last, where the capture has it first
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

	test('the input verdicts', () => {
		const accepted = INPUT_CORPUS.filter(([, input]) => parse(SelfServiceRoleSetInput, input).ok);
		assert.deepStrictEqual(
			accepted.map(([label]) => label),
			[
				'enable',
				'disable',
				'one letter',
				'at the cap',
				'with acting',
				'with acting uppercase',
				'with acting undefined'
			]
		);
	});

	test('the output verdicts', () => {
		const accepted = OUTPUT_CORPUS.filter(
			([, output]) => parse(SelfServiceRoleSetOutput, output).ok
		);
		assert.deepStrictEqual(
			accepted.map(([label]) => label),
			['changed', 'unchanged']
		);
	});

	test('an accepted input comes out as given, acting lowercased', () => {
		for (const [label, input] of INPUT_CORPUS.slice(0, 5)) {
			const result = parse(SelfServiceRoleSetInput, input);
			assert.ok(result.ok, label);
			assert.deepStrictEqual<unknown>(result.value, input, label);
		}
		const result = parse(SelfServiceRoleSetInput, {
			role: 'admin',
			enabled: true,
			acting: ID.toUpperCase()
		});
		assert.ok(result.ok);
		assert.deepStrictEqual<unknown>(result.value, { role: 'admin', enabled: true, acting: ID });
	});

	test('an invalid input gets its wire issues', () => {
		const cases: Array<[input: unknown, issues: Array<WireIssue>]> = [
			[
				{ role: LONG_OFF_GRAMMAR, enabled: 'yes', extra: 1 },
				[
					{
						kind: 'max_length',
						path: ['role'],
						expected: `length <= ${NAME_LENGTH_MAX}`,
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
						expected: String(NAME_REGEX),
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
			const result = parse(SelfServiceRoleSetInput, input);
			assert.ok(!result.ok, JSON.stringify(input));
			assert.deepStrictEqual(to_wire_issues(result.issues), issues, JSON.stringify(input));
		}
	});
});
