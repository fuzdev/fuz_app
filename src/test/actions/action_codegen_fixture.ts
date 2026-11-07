/**
 * A generated file built from every codegen block over fuz_app's own action
 * specs and synthetic specs of each input shape — the input of
 * `action_codegen.fixture.test.ts`, which holds the generated text to the
 * frozen `fixtures/action_codegen/fuz_expected.txt`.
 *
 * @module
 */

import {
	array,
	literal,
	number,
	object,
	optional,
	string,
	void as fuz_void,
	with_default
} from '@fuzdev/fuz_schema/schema.ts';

import {
	ImportBuilder,
	compose_gen_file,
	create_namespace_qualifier,
	generate_action_event_datas,
	generate_action_inputs_outputs,
	generate_action_method_enums,
	generate_action_specs_record,
	generate_backend_actions_api,
	generate_frontend_action_handlers,
	generate_frontend_actions_api,
	generate_typed_action_event_alias
} from '#lib/actions/action_codegen.ts';
import type { ActionSpecUnion } from '#lib/actions/action_spec.ts';
import { protocol_action_specs } from '#lib/actions/protocol.ts';
import { all_fuz_auth_action_spec_registries } from '#lib/auth/all_action_spec_registries.ts';
import { all_cell_action_specs } from '#lib/auth/cell_action_specs.ts';
import { all_cell_grant_action_specs } from '#lib/auth/cell_grant_action_specs.ts';
import { all_cell_field_action_specs } from '#lib/auth/cell_field_action_specs.ts';
import { all_cell_item_action_specs } from '#lib/auth/cell_item_action_specs.ts';
import { all_cell_audit_action_specs } from '#lib/auth/cell_audit_action_specs.ts';

// one spec per input shape the signature reads: void, null, optional, defaulted, required
const synthetic_specs: Array<ActionSpecUnion> = [
	{
		method: 'fixture_changed',
		kind: 'remote_notification',
		initiator: 'backend',
		auth: null,
		side_effects: true,
		input: object({ id: string }),
		output: fuz_void,
		async: true,
		description: 'a backend broadcast'
	},
	{
		method: 'fixture_ping',
		kind: 'remote_notification',
		initiator: 'frontend',
		auth: null,
		side_effects: true,
		input: fuz_void,
		output: fuz_void,
		async: true,
		description: 'a frontend notification with no input'
	},
	{
		method: 'fixture_toggle',
		kind: 'local_call',
		initiator: 'frontend',
		auth: null,
		side_effects: false,
		input: literal(null),
		output: literal(null),
		async: false,
		description: 'a sync local call with a null input'
	},
	{
		method: 'fixture_load',
		kind: 'local_call',
		initiator: 'frontend',
		auth: null,
		side_effects: false,
		input: optional(object({ path: string })),
		output: object({ text: string }),
		async: true,
		description: 'an async local call with an optional input'
	},
	{
		method: 'fixture/list',
		kind: 'request_response',
		initiator: 'frontend',
		auth: { account: 'required', actor: 'none' },
		side_effects: false,
		input: with_default(object({ limit: optional(number) }), {}),
		output: object({ items: array(string) }),
		async: true,
		description: 'a read with a defaulted input and a method that is no identifier'
	},
	{
		method: 'fixture_ask',
		kind: 'request_response',
		initiator: 'backend',
		auth: { account: 'none', actor: 'none' },
		side_effects: true,
		input: object({ question: string }),
		output: object({ answer: string }),
		async: true,
		description: 'a backend-initiated request'
	}
];

/**
 * fuz_app's own specs, as `action_spec_input_invariants.test.ts` walks them,
 * each method once (a spec can sit in more than one registry).
 */
const fuz_app_specs: Array<ActionSpecUnion> = [
	...new Map(
		[
			...all_fuz_auth_action_spec_registries.flatMap((r) => r.specs),
			...all_cell_action_specs,
			...all_cell_grant_action_specs,
			...all_cell_field_action_specs,
			...all_cell_item_action_specs,
			...all_cell_audit_action_specs,
			...protocol_action_specs
		].map((spec): [string, ActionSpecUnion] => [spec.method, spec])
	).values()
];

/** fuz_app's own specs and the synthetic ones, in the fixture's order. */
export const fixture_specs: Array<ActionSpecUnion> = [...fuz_app_specs, ...synthetic_specs];

/**
 * Every codegen block over `specs` composed into one file: once with the
 * default `* as specs` import and once through a namespace qualifier, with
 * protocol actions included and filtered, and sync local calls both
 * returning their value and wrapped.
 *
 * @param specs - the specs to generate from
 * @returns the composed file text
 */
export const generate_codegen_fixture = (specs: ReadonlyArray<ActionSpecUnion>): string => {
	const imports = new ImportBuilder();
	const blocks = [
		generate_action_method_enums(specs, imports),
		generate_action_method_enums(specs, imports, { include_protocol_actions: true }),
		generate_action_specs_record(specs, imports),
		generate_action_inputs_outputs(specs, imports),
		generate_action_inputs_outputs(specs, imports, { include_protocol_actions: true }),
		generate_action_event_datas(specs, imports, { same_file: false }),
		generate_frontend_actions_api(specs, imports),
		generate_frontend_actions_api(specs, imports, {
			sync_returns_value: false,
			include_protocol_actions: true
		}),
		generate_frontend_action_handlers(specs, imports),
		generate_backend_actions_api(specs, imports),
		generate_typed_action_event_alias(imports)
	];
	const qualified_imports = new ImportBuilder();
	const { qualify_spec } = create_namespace_qualifier(
		[{ ns: 'fixture_specs', module: './fixture_specs.ts', specs }],
		qualified_imports
	);
	const qualified_blocks = [
		generate_action_specs_record(specs, qualified_imports, { qualify_spec }),
		generate_action_inputs_outputs(specs, qualified_imports, { qualify_spec }),
		generate_backend_actions_api(specs, qualified_imports, { qualify_spec })
	];
	return (
		compose_gen_file({ origin_path: 'fixture.gen.ts', imports, blocks }) +
		compose_gen_file({
			origin_path: 'fixture_qualified.gen.ts',
			imports: qualified_imports,
			blocks: qualified_blocks
		})
	);
};
