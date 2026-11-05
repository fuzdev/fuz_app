/**
 * An all-Zod spec list generates the text the Zod-only codegen emitted, byte
 * for byte: the fixture in `fixtures/action_codegen/all_zod_expected.txt` is that
 * text, generated from `zod_fixture_specs` by `generate_codegen_fixture`. The
 * codegen's reading of a `@fuzdev/fuz_schema` spec must leave a Zod spec's
 * output alone, so the fixture never changes for an all-Zod list.
 *
 * fuz_app's own list, whose `account_token_revoke`, `actor_lookup` and
 * `actor_search` are `@fuzdev/fuz_schema`, generates the same text but for
 * those methods' types, read by `Infer`, and the `Infer` import. The all-Zod
 * list holds Zod stand-ins for those methods' schemas, which give codegen the
 * answers their own do.
 *
 * @module
 */

import { assert, test } from 'vitest';
import { readFileSync } from 'node:fs';

import { action_input_is_optional } from '#lib/actions/action_codegen.ts';
import { is_null_schema, is_void_schema } from '#lib/http/schema_helpers.ts';

import {
	fixture_specs,
	fuz_schema_methods,
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
	assert.deepStrictEqual(fuz_schema_methods, [
		'account_token_revoke',
		'actor_lookup',
		'actor_search'
	]);
	const changed = actual.filter((line) => line.includes(': Infer<'));
	// each method's input and output, in the plain inputs-outputs block, the
	// protocol-including one, and the qualified one
	const typed = (ns: string, kind: string): Array<string> =>
		fuz_schema_methods.map(
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
	for (const method of fuz_schema_methods) {
		restored = restored.replaceAll(`${method}: Infer<`, `${method}: z.infer<`);
	}
	assert.strictEqual(restored, expected);
});

test('the Zod stand-ins give codegen the answers the fuz_schema methods give', () => {
	const by_method = new Map(zod_fixture_specs.map((spec) => [spec.method, spec]));
	for (const method of fuz_schema_methods) {
		const own = fixture_specs.find((spec) => spec.method === method)!;
		const stand_in = by_method.get(method)!;
		assert.notStrictEqual(stand_in.input, own.input, method);
		assert.strictEqual(is_null_schema(stand_in.input), is_null_schema(own.input), method);
		assert.strictEqual(is_void_schema(stand_in.input), is_void_schema(own.input), method);
		assert.strictEqual(action_input_is_optional(stand_in), action_input_is_optional(own), method);
		assert.isFalse(action_input_is_optional(own), method);
	}
});
