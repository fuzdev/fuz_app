/**
 * fuz_app's own spec list generates the frozen text byte for byte: the fixture
 * in `fixtures/action_codegen/fuz_expected.txt` is that text, generated from
 * `fixture_specs` by `generate_codegen_fixture`. It pins the `Infer` and
 * `InferInput` types and their import of every block, so a codegen change
 * shows as a diff.
 *
 * Regenerate the fixture with
 * `gro task src/test/fixtures/action_codegen/update.task.ts`.
 *
 * @module
 */

import { assert, test } from 'vitest';
import { readFileSync } from 'node:fs';

import { fixture_specs, generate_codegen_fixture } from './action_codegen_fixture.ts';

const FIXTURE_PATH = new URL('../fixtures/action_codegen/fuz_expected.txt', import.meta.url);

const INFER_IMPORT = "import type {Infer, InferInput} from '@fuzdev/fuz_schema/schema.ts';";

test("fuz_app's own spec list generates the fixture byte for byte", () => {
	const expected = readFileSync(FIXTURE_PATH, 'utf8');
	assert.ok(expected.length > 0);
	assert.strictEqual(generate_codegen_fixture(fixture_specs), expected);
});

test('the fixture pins the Infer and InferInput lines and import', () => {
	const lines = readFileSync(FIXTURE_PATH, 'utf8').split('\n');
	assert.ok(lines.includes(INFER_IMPORT));
	assert.ok(lines.some((line) => line.includes(': Infer<typeof specs.')));
	assert.ok(lines.some((line) => line.includes(': Infer<typeof fixture_specs.')));
	assert.ok(lines.some((line) => line.includes(': InferInput<typeof specs.')));
	assert.ok(lines.some((line) => line.includes(': InferInput<typeof fixture_specs.')));
	assert.notInclude(lines.join('\n'), 'z.infer');
});
