/**
 * A generated file built from every codegen block over an all-Zod spec list —
 * fuz_app's own action specs and synthetic specs of each kind — the input of
 * `action_codegen.zod_fixture.test.ts`, which holds it to the text the
 * Zod-only codegen emitted, and holds fuz_app's own list, whose
 * `@fuzdev/fuz_schema` inputs and outputs (`account_token_revoke`,
 * `self_service_role_set`, `actor_lookup`, `actor_search`, the
 * role_grant_offer methods, the admin methods' inputs and their outputs but
 * those that hold an audit or invite row, `account_session_revoke`'s input,
 * and the outputs of `account_verify` and `account_session_list`), to that
 * text with those types read by `Infer`.
 *
 * @module
 */

import { z } from 'zod';

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
import { parse_any } from '#lib/schema_issues.ts';
import { is_schema } from '@fuzdev/fuz_schema/schema.ts';

// one spec per input shape the signature reads: void, null, optional, defaulted, required
const synthetic_specs: Array<ActionSpecUnion> = [
	{
		method: 'fixture_changed',
		kind: 'remote_notification',
		initiator: 'backend',
		auth: null,
		side_effects: true,
		input: z.strictObject({ id: z.string() }),
		output: z.void(),
		async: true,
		description: 'a backend broadcast'
	},
	{
		method: 'fixture_ping',
		kind: 'remote_notification',
		initiator: 'frontend',
		auth: null,
		side_effects: true,
		input: z.void(),
		output: z.void(),
		async: true,
		description: 'a frontend notification with no input'
	},
	{
		method: 'fixture_toggle',
		kind: 'local_call',
		initiator: 'frontend',
		auth: null,
		side_effects: false,
		input: z.null(),
		output: z.null(),
		async: false,
		description: 'a sync local call with a null input'
	},
	{
		method: 'fixture_load',
		kind: 'local_call',
		initiator: 'frontend',
		auth: null,
		side_effects: false,
		input: z.strictObject({ path: z.string() }).optional(),
		output: z.strictObject({ text: z.string() }),
		async: true,
		description: 'an async local call with an optional input'
	},
	{
		method: 'fixture/list',
		kind: 'request_response',
		initiator: 'frontend',
		auth: { account: 'required', actor: 'none' },
		side_effects: false,
		input: z.strictObject({ limit: z.number().optional() }).default({}),
		output: z.strictObject({ items: z.array(z.string()) }),
		async: true,
		description: 'a read with a defaulted input and a method that is no identifier'
	},
	{
		method: 'fixture_ask',
		kind: 'request_response',
		initiator: 'backend',
		auth: { account: 'none', actor: 'none' },
		side_effects: true,
		input: z.strictObject({ question: z.string() }),
		output: z.strictObject({ answer: z.string() }),
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

/**
 * The Zod stand-in for a `@fuzdev/fuz_schema` input. Codegen reads an input
 * for its library, whether it is null or void, and whether it takes
 * `undefined` or `{}` (or carries the `empty_input_handler_guarded` marker): a
 * required key, as most of these inputs have, gives every answer theirs does,
 * which `action_codegen.zod_fixture.test.ts` holds it to.
 */
const ZodRequiredInput = z.strictObject({ required: z.string() });

/**
 * The Zod stand-in for such an input that takes `undefined`, as the defaulted
 * inputs of the listings do: an object of optional keys with a `{}` default,
 * which takes `undefined` and `{}` as theirs do.
 */
const ZodDefaultedInput = z.strictObject({ optional: z.string().optional() }).default({});

/** The Zod stand-in for a `@fuzdev/fuz_schema` output, of which codegen reads only the library. */
const ZodOutput = z.strictObject({});

/** The spec with each `@fuzdev/fuz_schema` side replaced by its Zod stand-in. */
const to_zod_spec = (spec: ActionSpecUnion): ActionSpecUnion =>
	({
		...spec,
		input: is_schema(spec.input)
			? parse_any(spec.input, undefined).ok
				? ZodDefaultedInput
				: ZodRequiredInput
			: spec.input,
		output: is_schema(spec.output) ? ZodOutput : spec.output
	}) as ActionSpecUnion;

/**
 * The methods of fuz_app's own list whose input is `@fuzdev/fuz_schema`, in
 * the fixture's order.
 */
export const fuz_schema_input_methods: ReadonlyArray<string> = fuz_app_specs
	.filter((spec) => is_schema(spec.input))
	.map((spec) => spec.method);

/**
 * The methods of fuz_app's own list whose output is `@fuzdev/fuz_schema`, in
 * the fixture's order.
 */
export const fuz_schema_output_methods: ReadonlyArray<string> = fuz_app_specs
	.filter((spec) => is_schema(spec.output))
	.map((spec) => spec.method);

/** fuz_app's own specs and the synthetic ones, in the fixture's order. */
export const fixture_specs: Array<ActionSpecUnion> = [...fuz_app_specs, ...synthetic_specs];

/** The all-Zod spec list the fixture is generated from. */
export const zod_fixture_specs: Array<ActionSpecUnion> = fixture_specs.map(to_zod_spec);

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
