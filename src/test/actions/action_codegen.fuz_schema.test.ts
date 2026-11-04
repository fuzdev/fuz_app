/**
 * Codegen over `@fuzdev/fuz_schema` specs: the emitted types (`Infer` beside
 * `z.infer`), the imports each library needs, the no-input and optional-input
 * signatures read by shape and parse, and the throw on a schema of neither
 * library.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { z } from 'zod';
import {
	literal,
	object,
	optional,
	string,
	void as fuz_void,
	with_default
} from '@fuzdev/fuz_schema/schema.ts';
import { meta } from '@fuzdev/fuz_schema/meta.ts';

import {
	ImportBuilder,
	action_input_is_optional,
	generate_action_inputs_outputs,
	generate_frontend_actions_api
} from '#lib/actions/action_codegen.ts';
import type { ActionSpecUnion } from '#lib/actions/action_spec.ts';
import type { ValidationSchema } from '#lib/schema_issues.ts';

const create_spec = (
	method: string,
	input: ValidationSchema,
	output: ValidationSchema = z.strictObject({ ok: z.boolean() })
): ActionSpecUnion => ({
	method,
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'none', actor: 'none' },
	side_effects: true,
	input,
	output,
	async: true,
	description: method
});

const zod_spec = create_spec('zod_thing', z.strictObject({ name: z.string() }));
const fuz_spec = create_spec('fuz_thing', object({ name: string }), object({ ok: literal(true) }));

const FUZ_INFER_IMPORT = "import type {Infer} from '@fuzdev/fuz_schema/schema.ts';";
const ZOD_IMPORT = "import {z} from 'zod';";

describe('generate_action_inputs_outputs over fuz_schema specs', () => {
	test('a mixed list emits each spec in its own library, with both imports', () => {
		const imports = new ImportBuilder();
		const block = generate_action_inputs_outputs([zod_spec, fuz_spec], imports);
		assert.include(block, '\tzod_thing: z.infer<typeof specs.zod_thing_action_spec.input>;');
		assert.include(block, '\tzod_thing: z.infer<typeof specs.zod_thing_action_spec.output>;');
		assert.include(block, '\tfuz_thing: Infer<typeof specs.fuz_thing_action_spec.input>;');
		assert.include(block, '\tfuz_thing: Infer<typeof specs.fuz_thing_action_spec.output>;');
		const built = imports.build();
		assert.include(built, ZOD_IMPORT);
		assert.include(built, FUZ_INFER_IMPORT);
	});

	test('an all-fuz_schema list imports no zod', () => {
		const imports = new ImportBuilder();
		const block = generate_action_inputs_outputs([fuz_spec], imports);
		assert.notInclude(block, 'z.infer');
		const built = imports.build();
		assert.notInclude(built, 'zod');
		assert.include(built, FUZ_INFER_IMPORT);
	});

	test('a spec mixing libraries across input and output reads each', () => {
		const imports = new ImportBuilder();
		const spec = create_spec('half_thing', object({ name: string }));
		const block = generate_action_inputs_outputs([spec], imports);
		assert.include(block, '\thalf_thing: Infer<typeof specs.half_thing_action_spec.input>;');
		assert.include(block, '\thalf_thing: z.infer<typeof specs.half_thing_action_spec.output>;');
		const built = imports.build();
		assert.include(built, ZOD_IMPORT);
		assert.include(built, FUZ_INFER_IMPORT);
	});

	test('an all-Zod list imports no fuz_schema', () => {
		const imports = new ImportBuilder();
		generate_action_inputs_outputs([zod_spec], imports);
		assert.notInclude(imports.build(), 'fuz_schema');
	});

	test('a schema of neither library throws, naming the method', () => {
		for (const [spec, which] of [
			[create_spec('bad_input', {} as z.ZodType), 'input'],
			[create_spec('bad_output', z.strictObject({}), {} as z.ZodType), 'output']
		] as const) {
			assert.throws(
				() => generate_action_inputs_outputs([spec], new ImportBuilder()),
				new RegExp(
					`action '${spec.method}' ${which} is neither a Zod schema nor a @fuzdev/fuz_schema schema`
				)
			);
		}
	});
});

describe('FrontendActionsApi signature over fuz_schema specs', () => {
	const signature = (spec: ActionSpecUnion, imports = new ImportBuilder()): string =>
		generate_frontend_actions_api([spec], imports)
			.split('\n')
			.find((line) => line.startsWith(`\t${spec.method}:`))!;

	test('a fuz_schema void input emits the no-input signature', () => {
		for (const input of [fuz_void, meta(fuz_void, { description: 'nothing' }), literal(null)]) {
			const imports = new ImportBuilder();
			const line = signature(create_spec('fuz_ping', input), imports);
			assert.include(line, 'fuz_ping: (input?: void, options?: RpcClientCallOptions)');
			assert.notInclude(imports.build(), 'ActionInputs');
		}
	});

	// TODO: dispatch reads absent params as `{}` for a wrapped void (`is_void_schema` is exact), which it refuses — the optional signature invites a failing call
	test('a void under a wrapper has input, optional, as its undefined probe passes', () => {
		const line = signature(create_spec('wrapped_void', z.void().optional()));
		assert.include(
			line,
			"wrapped_void: (input?: ActionInputs['wrapped_void'], options?: RpcClientCallOptions)"
		);
	});

	test('a required fuz_schema input stays required', () => {
		assert.include(
			signature(fuz_spec),
			"fuz_thing: (input: ActionInputs['fuz_thing'], options?: RpcClientCallOptions)"
		);
	});

	test('a fuz_schema input accepting undefined or {} is optional', () => {
		for (const input of [
			optional(object({ name: string })),
			with_default(object({ name: optional(string) }), {}),
			object({ name: optional(string) })
		]) {
			assert.include(
				signature(create_spec('fuz_list', input)),
				"fuz_list: (input?: ActionInputs['fuz_list'], options?: RpcClientCallOptions)"
			);
		}
	});

	test('a handler-guarded fuz_schema input accepting {} stays required', () => {
		const input = meta(object({ id: optional(string) }), { empty_input_handler_guarded: true });
		const spec = create_spec('fuz_get', input);
		assert.isFalse(action_input_is_optional(spec));
		assert.include(
			signature(spec),
			"fuz_get: (input: ActionInputs['fuz_get'], options?: RpcClientCallOptions)"
		);
	});

	test('a schema of neither library throws, naming the method', () => {
		assert.throws(
			() => signature(create_spec('bad_thing', {} as z.ZodType)),
			/action 'bad_thing' input is neither a Zod schema nor a @fuzdev\/fuz_schema schema/
		);
	});
});
