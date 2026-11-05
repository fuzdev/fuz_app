/**
 * An all-Zod spec list generates the text the Zod-only codegen emitted, byte
 * for byte: the fixture in `fixtures/action_codegen/all_zod_expected.txt` is that
 * text, generated from `zod_fixture_specs` by `generate_codegen_fixture`. The
 * codegen's reading of a `@fuzdev/fuz_schema` spec must leave a Zod spec's
 * output alone, so the fixture never changes for an all-Zod list.
 *
 * fuz_app's own list, whose `account_token_revoke`, `self_service_role_set`,
 * `actor_lookup`, `actor_search` and role_grant_offer methods are
 * `@fuzdev/fuz_schema`, as are the admin methods' inputs and row-free outputs,
 * generates the same text but for those types, read by `Infer`, and the
 * `Infer` import. The all-Zod list holds Zod stand-ins for those schemas,
 * which give codegen the answers their own do.
 *
 * @module
 */

import { assert, test } from 'vitest';
import { readFileSync } from 'node:fs';

import { action_input_is_optional } from '#lib/actions/action_codegen.ts';
import { is_null_schema, is_void_schema } from '#lib/http/schema_helpers.ts';

import {
	fixture_specs,
	fuz_schema_input_methods,
	fuz_schema_output_methods,
	generate_codegen_fixture,
	zod_fixture_specs
} from './action_codegen_fixture.ts';

const FIXTURE_PATH = new URL('../fixtures/action_codegen/all_zod_expected.txt', import.meta.url);

const INFER_IMPORT = "import type {Infer} from '@fuzdev/fuz_schema/schema.ts';";

test('an all-Zod spec list generates the fixture byte for byte', () => {
	const expected = readFileSync(FIXTURE_PATH, 'utf8');
	assert.ok(expected.length > 0);
	assert.strictEqual(generate_codegen_fixture(zod_fixture_specs), expected);
});

test("fuz_app's own list differs from the fixture only in its fuz_schema methods' types", () => {
	const expected = readFileSync(FIXTURE_PATH, 'utf8');
	const actual = generate_codegen_fixture(fixture_specs).split('\n');
	// one `Infer` import per composed file, the plain and the qualified
	assert.strictEqual(actual.filter((line) => line === INFER_IMPORT).length, 2);
	assert.notInclude(expected, INFER_IMPORT);
	const fully: ReadonlyArray<string> = [
		'role_grant_offer_create',
		'role_grant_offer_accept',
		'role_grant_offer_decline',
		'role_grant_offer_retract',
		'role_grant_offer_list',
		'role_grant_offer_history',
		'role_grant_revoke',
		'role_grant_assign',
		'account_token_revoke',
		'self_service_role_set',
		'actor_lookup',
		'actor_search'
	];
	// the admin methods, in the registry's order and ahead of the others in the
	// fixture's; those with a row in their output keep it Zod
	const admin_inputs: ReadonlyArray<string> = [
		'admin_account_list',
		'admin_session_list',
		'admin_session_revoke_all',
		'admin_token_revoke_all',
		'audit_log_list',
		'audit_log_role_grant_history',
		'invite_create',
		'invite_list',
		'invite_delete',
		'account_delete',
		'account_purge',
		'account_undelete',
		'app_settings_get',
		'app_settings_update'
	];
	const zod_outputs = new Set([
		'admin_account_list',
		'admin_session_list',
		'audit_log_list',
		'audit_log_role_grant_history',
		'invite_create',
		'invite_list'
	]);
	assert.deepStrictEqual(fuz_schema_input_methods, [...admin_inputs, ...fully]);
	assert.deepStrictEqual(fuz_schema_output_methods, [
		...admin_inputs.filter((method) => !zod_outputs.has(method)),
		...fully
	]);
	const changed = actual.filter((line) => line.includes(': Infer<'));
	// each method's input and output, in the plain inputs-outputs block, the
	// protocol-including one, and the qualified one
	const typed = (ns: string, kind: 'input' | 'output'): Array<string> =>
		(kind === 'input' ? fuz_schema_input_methods : fuz_schema_output_methods).map(
			(method) => `\t${method}: Infer<typeof ${ns}.${method}_action_spec.${kind}>;`
		);
	assert.deepStrictEqual(changed, [
		...typed('specs', 'input'),
		...typed('specs', 'output'),
		...typed('specs', 'input'),
		...typed('specs', 'output'),
		...typed('fixture_specs', 'input'),
		...typed('fixture_specs', 'output')
	]);
	let restored = actual.filter((line) => line !== INFER_IMPORT).join('\n');
	for (const method of fuz_schema_input_methods) {
		restored = restored.replaceAll(`${method}: Infer<`, `${method}: z.infer<`);
	}
	assert.strictEqual(restored, expected);
});

test('the Zod stand-ins give codegen the answers the fuz_schema methods give', () => {
	const by_method = new Map(zod_fixture_specs.map((spec) => [spec.method, spec]));
	for (const method of fuz_schema_input_methods) {
		const own = fixture_specs.find((spec) => spec.method === method)!;
		const stand_in = by_method.get(method)!;
		assert.notStrictEqual(stand_in.input, own.input, method);
		assert.strictEqual(is_null_schema(stand_in.input), is_null_schema(own.input), method);
		assert.strictEqual(is_void_schema(stand_in.input), is_void_schema(own.input), method);
		assert.strictEqual(action_input_is_optional(stand_in), action_input_is_optional(own), method);
	}
	// a Zod output stays itself beside a fuz_schema input
	for (const spec of fixture_specs) {
		const stand_in = by_method.get(spec.method)!;
		const output_is_own = !fuz_schema_output_methods.includes(spec.method);
		assert.strictEqual(stand_in.output === spec.output, output_is_own, spec.method);
	}
	// the defaulted stand-in is reached: the defaulted inputs take `undefined`
	assert.deepStrictEqual(
		fuz_schema_input_methods.filter((method) =>
			action_input_is_optional(fixture_specs.find((spec) => spec.method === method)!)
		),
		[
			'admin_account_list',
			'admin_session_list',
			'audit_log_list',
			'audit_log_role_grant_history',
			'invite_list',
			'account_delete',
			'app_settings_get',
			'role_grant_offer_list',
			'role_grant_offer_history'
		]
	);
});
