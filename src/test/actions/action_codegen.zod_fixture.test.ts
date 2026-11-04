/**
 * An all-Zod spec list generates the text the Zod-only codegen emitted, byte
 * for byte: the fixture in `fixtures/action_codegen/all_zod_expected.txt` is that
 * text, generated from `zod_fixture_specs` by `generate_codegen_fixture`. The
 * codegen's reading of a `@fuzdev/fuz_schema` spec must leave a Zod spec's
 * output alone, so the fixture never changes for an all-Zod list.
 *
 * @module
 */

import { assert, test } from 'vitest';
import { readFileSync } from 'node:fs';

import { generate_codegen_fixture, zod_fixture_specs } from './action_codegen_fixture.ts';

const FIXTURE_PATH = new URL('../fixtures/action_codegen/all_zod_expected.txt', import.meta.url);

test('an all-Zod spec list generates the fixture byte for byte', () => {
	const expected = readFileSync(FIXTURE_PATH, 'utf8');
	assert.ok(expected.length > 0);
	assert.strictEqual(generate_codegen_fixture(zod_fixture_specs), expected);
});
