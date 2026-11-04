/**
 * An all-Zod spec list generates the text the Zod-only codegen emitted, byte
 * for byte: the fixture in `fixtures/action_codegen/all_zod_expected.txt` is that
 * text, generated from `zod_fixture_specs` by `generate_codegen_fixture`. The
 * codegen's reading of a `@fuzdev/fuz_schema` spec must leave a Zod spec's
 * output alone, so the fixture never changes for an all-Zod list.
 *
 * fuz_app's own list, whose `account_token_revoke` is `@fuzdev/fuz_schema`,
 * generates the same text but for that method's types, read by `Infer`, and
 * the `Infer` import.
 *
 * @module
 */

import { assert, test } from 'vitest';
import { readFileSync } from 'node:fs';

import {
	fixture_specs,
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

test("fuz_app's own list differs from the fixture only in `account_token_revoke`'s types", () => {
	const expected = readFileSync(FIXTURE_PATH, 'utf8');
	const actual = generate_codegen_fixture(fixture_specs).split('\n');
	// one `Infer` import per composed file, the plain and the qualified
	assert.strictEqual(actual.filter((line) => line === INFER_IMPORT).length, 2);
	assert.notInclude(expected, INFER_IMPORT);
	const changed = actual.filter((line) => line.includes('account_token_revoke: Infer<'));
	assert.deepStrictEqual(changed, [
		'\taccount_token_revoke: Infer<typeof specs.account_token_revoke_action_spec.input>;',
		'\taccount_token_revoke: Infer<typeof specs.account_token_revoke_action_spec.output>;',
		'\taccount_token_revoke: Infer<typeof specs.account_token_revoke_action_spec.input>;',
		'\taccount_token_revoke: Infer<typeof specs.account_token_revoke_action_spec.output>;',
		'\taccount_token_revoke: Infer<typeof fixture_specs.account_token_revoke_action_spec.input>;',
		'\taccount_token_revoke: Infer<typeof fixture_specs.account_token_revoke_action_spec.output>;'
	]);
	assert.strictEqual(
		actual
			.filter((line) => line !== INFER_IMPORT)
			.join('\n')
			.replaceAll('account_token_revoke: Infer<', 'account_token_revoke: z.infer<'),
		expected
	);
});
