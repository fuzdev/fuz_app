/**
 * An all-Zod spec list generates the text the Zod-only codegen emitted, byte
 * for byte: the fixture in `fixtures/action_codegen/all_zod_expected.txt` is that
 * text, generated from `zod_fixture_specs` by `generate_codegen_fixture`. The
 * codegen's reading of a `@fuzdev/fuz_schema` spec must leave a Zod spec's
 * output alone, so the fixture never changes for an all-Zod list.
 *
 * fuz_app's own list, whose account, `self_service_role_set`,
 * `actor_lookup`, `actor_search`, admin, role_grant_offer, cell, and protocol
 * methods are `@fuzdev/fuz_schema`, generates the same text but for those types, read by `Infer`, and the
 * `Infer` import. The all-Zod list holds Zod stand-ins for those schemas,
 * which give codegen the answers their own do.
 *
 * @module
 */

import { assert, test } from 'vitest';
import { readFileSync } from 'node:fs';

import {
	action_input_is_optional,
	is_protocol_action_method
} from '#lib/actions/action_codegen.ts';
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
	const offers: ReadonlyArray<string> = [
		'role_grant_offer_create',
		'role_grant_offer_accept',
		'role_grant_offer_decline',
		'role_grant_offer_retract',
		'role_grant_offer_list',
		'role_grant_offer_history',
		'role_grant_revoke',
		'role_grant_assign'
	];
	const fully: ReadonlyArray<string> = [
		'account_verify',
		'account_session_list',
		'account_session_revoke',
		'account_session_revoke_all',
		'account_token_create',
		'account_token_list',
		'account_token_revoke',
		'self_service_role_set',
		'actor_lookup',
		'actor_search'
	];
	// the admin methods, in the registry's order and ahead of the others in the
	// fixture's
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
	// the cell methods, in `all_cell_action_specs`' order
	const cells: ReadonlyArray<string> = [
		'cell_create',
		'cell_get',
		'cell_update',
		'cell_delete',
		'cell_list',
		'cell_clone',
		'cell_moderate',
		'cell_policy_set',
		'cell_grant_create',
		'cell_grant_revoke',
		'cell_grant_list',
		'cell_field_set',
		'cell_field_delete',
		'cell_field_list',
		'cell_item_insert',
		'cell_item_move',
		'cell_item_delete',
		'cell_item_list',
		'cell_audit_list'
	];
	// the protocol methods, in `protocol_action_specs`' order
	const protocol: ReadonlyArray<string> = ['heartbeat', 'cancel', 'peer/ping'];
	assert.deepStrictEqual(fuz_schema_input_methods, [
		...admin_inputs,
		...offers,
		...fully,
		...cells,
		...protocol
	]);
	assert.deepStrictEqual(fuz_schema_output_methods, [
		...admin_inputs,
		...offers,
		...fully,
		...cells,
		...protocol
	]);
	const changed = actual.filter((line) => line.includes(': Infer<'));
	// a method's property key and spec identifier, as codegen writes them
	const to_key = (method: string): string =>
		/^[A-Za-z_$][\w$]*$/.test(method) ? method : `'${method}'`;
	const to_spec = (method: string): string => `${method.replaceAll('/', '_')}_action_spec`;
	// each method's input and output, in the plain inputs-outputs block, the
	// protocol-including one, and the qualified one; the protocol methods only
	// in the protocol-including one
	const typed = (ns: string, kind: 'input' | 'output', with_protocol = false): Array<string> =>
		(kind === 'input' ? fuz_schema_input_methods : fuz_schema_output_methods)
			.filter((method) => with_protocol || !is_protocol_action_method(method))
			.map((method) => `\t${to_key(method)}: Infer<typeof ${ns}.${to_spec(method)}.${kind}>;`);
	assert.deepStrictEqual(changed, [
		...typed('specs', 'input'),
		...typed('specs', 'output'),
		...typed('specs', 'input', true),
		...typed('specs', 'output', true),
		...typed('fixture_specs', 'input'),
		...typed('fixture_specs', 'output')
	]);
	let restored = actual.filter((line) => line !== INFER_IMPORT).join('\n');
	for (const method of new Set([...fuz_schema_input_methods, ...fuz_schema_output_methods])) {
		restored = restored.replaceAll(`${to_key(method)}: Infer<`, `${to_key(method)}: z.infer<`);
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
	const own_input = (method: string) => fixture_specs.find((spec) => spec.method === method)!;
	// the void stand-in is reached
	assert.deepStrictEqual(
		fuz_schema_input_methods.filter((method) => is_void_schema(own_input(method).input)),
		[
			'account_verify',
			'account_session_list',
			'account_session_revoke_all',
			'account_token_list',
			'heartbeat'
		]
	);
	// the defaulted stand-in is reached: the defaulted inputs take `undefined`
	assert.deepStrictEqual(
		fuz_schema_input_methods.filter(
			(method) =>
				!is_void_schema(own_input(method).input) && action_input_is_optional(own_input(method))
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
			'role_grant_offer_history',
			'cell_list',
			'peer/ping'
		]
	);
});
