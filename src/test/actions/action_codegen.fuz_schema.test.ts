/**
 * Codegen over `@fuzdev/fuz_schema` specs: the emitted `Infer` and
 * `InferInput` types and their import, the caller's input type against the
 * handler's, the no-input and optional-input signatures read by shape and parse,
 * and the throw on a value that is not a schema.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import {
	boolean,
	literal,
	number,
	object,
	parse,
	optional,
	string,
	void as fuz_void,
	with_default,
	type AnySchema,
	type Infer,
	type InferInput
} from '@fuzdev/fuz_schema/schema.ts';
import { meta } from '@fuzdev/fuz_schema/meta.ts';

import {
	ImportBuilder,
	action_input_is_optional,
	generate_action_inputs_outputs,
	generate_frontend_actions_api
} from '#lib/actions/action_codegen.ts';
import type { ActionSpecUnion } from '#lib/actions/action_spec.ts';

const create_spec = (
	method: string,
	input: AnySchema,
	output: AnySchema = object({ ok: boolean })
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

const fuz_spec = create_spec('fuz_thing', object({ name: string }), object({ ok: literal(true) }));

const FUZ_INFER_IMPORT = "import type {Infer, InferInput} from '@fuzdev/fuz_schema/schema.ts';";

describe('generate_action_inputs_outputs over fuz_schema specs', () => {
	test('emits each spec as `Infer` and its input as `InferInput` too, importing both', () => {
		const imports = new ImportBuilder();
		const block = generate_action_inputs_outputs([fuz_spec], imports);
		assert.include(block, '\tfuz_thing: Infer<typeof specs.fuz_thing_action_spec.input>;');
		assert.include(block, '\tfuz_thing: InferInput<typeof specs.fuz_thing_action_spec.input>;');
		assert.include(block, '\tfuz_thing: Infer<typeof specs.fuz_thing_action_spec.output>;');
		assert.notInclude(block, 'InferInput<typeof specs.fuz_thing_action_spec.output>');
		assert.include(imports.build(), FUZ_INFER_IMPORT);
	});

	test('a defaulted input field is optional for the caller and required for the handler', () => {
		const input = object({ name: string, limit: with_default(number, 10) });
		const spec = create_spec('fuz_page', input);

		// the caller's surface reads the input type, the handler's the output type
		const block = generate_action_inputs_outputs([spec], new ImportBuilder());
		const interface_of = (name: string): string =>
			block.slice(block.indexOf(`export interface ${name} {`)).split('\n}')[0]!;
		assert.include(
			interface_of('ActionCallInputs'),
			'\tfuz_page: InferInput<typeof specs.fuz_page_action_spec.input>;'
		);
		assert.include(
			interface_of('ActionInputs'),
			'\tfuz_page: Infer<typeof specs.fuz_page_action_spec.input>;'
		);
		assert.include(
			generate_frontend_actions_api([spec], new ImportBuilder()),
			"fuz_page: (input: ActionCallInputs['fuz_page'], options?: RpcClientCallOptions)"
		);

		// the two types: a caller may leave `limit` out, a handler reads it filled in
		const call: InferInput<typeof input> = { name: 'a' };
		// @ts-expect-error a handler's input has `limit`
		const missing_limit: Infer<typeof input> = { name: 'a' };
		const handled: Infer<typeof input> = { name: 'a', limit: 10 };
		const parsed = parse(input, call);
		assert.ok(parsed.ok);
		assert.deepStrictEqual(parsed.value, handled);
		assert.notDeepEqual(missing_limit, parsed.value);
	});

	test('a value that is not a schema throws, naming the method', () => {
		for (const [spec, which] of [
			[create_spec('bad_input', {} as AnySchema), 'input'],
			[create_spec('bad_output', object({}), {} as AnySchema), 'output']
		] as const) {
			assert.throws(
				() => generate_action_inputs_outputs([spec], new ImportBuilder()),
				new RegExp(`action '${spec.method}' ${which} is .*a @fuzdev/fuz_schema schema$`)
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
			assert.notInclude(imports.build(), 'ActionCallInputs');
		}
	});

	// TODO: dispatch reads absent params as `{}` for a wrapped void (`is_void_schema` is exact), which it refuses — the optional signature invites a failing call
	test('a void under a wrapper has input, optional, as its undefined probe passes', () => {
		const line = signature(create_spec('wrapped_void', optional(fuz_void)));
		assert.include(
			line,
			"wrapped_void: (input?: ActionCallInputs['wrapped_void'], options?: RpcClientCallOptions)"
		);
	});

	test('a required fuz_schema input stays required', () => {
		assert.include(
			signature(fuz_spec),
			"fuz_thing: (input: ActionCallInputs['fuz_thing'], options?: RpcClientCallOptions)"
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
				"fuz_list: (input?: ActionCallInputs['fuz_list'], options?: RpcClientCallOptions)"
			);
		}
	});

	test('a handler-guarded fuz_schema input accepting {} stays required', () => {
		const input = meta(object({ id: optional(string) }), { empty_input_handler_guarded: true });
		const spec = create_spec('fuz_get', input);
		assert.isFalse(action_input_is_optional(spec));
		assert.include(
			signature(spec),
			"fuz_get: (input: ActionCallInputs['fuz_get'], options?: RpcClientCallOptions)"
		);
	});

	test('a value that is not a schema throws, naming the method', () => {
		assert.throws(
			() => signature(create_spec('bad_thing', {} as AnySchema)),
			/action 'bad_thing' input is .*a @fuzdev\/fuz_schema schema$/
		);
	});
});
