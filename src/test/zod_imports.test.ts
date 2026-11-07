/**
 * No library module imports Zod at runtime but `zod_schemas.ts`, the Zod
 * forms of the primitives an app's Zod schemas embed: the dual-library layer
 * reads a consumer's Zod schema by its traits (`zod_has_trait`) and its own
 * methods, so an app with no Zod schema loads no Zod.
 *
 * @module
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, test } from 'vitest';

const LIB_DIR = fileURLToPath(new URL('../lib/', import.meta.url));

/** The one module allowed a runtime import of Zod. */
const ZOD_RUNTIME_MODULES: ReadonlySet<string> = new Set(['zod_schemas.ts']);

const list_sources = (dir: string): Array<string> =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return list_sources(path);
		return /\.(ts|svelte)$/.test(entry.name) ? [path] : [];
	});

// an `import` of `zod` that isn't `import type`, a side-effect import included
const ZOD_VALUE_IMPORT = /^\s*import\s+(?!type\s)(?:[^;]*?\sfrom\s+)?['"]zod(?:\/[^'"]*)?['"]/m;

test('only zod_schemas.ts imports Zod at runtime', () => {
	const importers = list_sources(LIB_DIR)
		.filter((path) => ZOD_VALUE_IMPORT.test(readFileSync(path, 'utf8')))
		.map((path) => relative(LIB_DIR, path));
	assert.deepStrictEqual(importers.sort(), [...ZOD_RUNTIME_MODULES]);
});

test('the pattern tells a value import from a type import', () => {
	assert.ok(ZOD_VALUE_IMPORT.test("import { z } from 'zod';"));
	assert.ok(ZOD_VALUE_IMPORT.test("import * as z from 'zod';"));
	assert.ok(ZOD_VALUE_IMPORT.test("\timport { z } from 'zod/v4';"));
	assert.ok(ZOD_VALUE_IMPORT.test("import 'zod';"));
	assert.isFalse(ZOD_VALUE_IMPORT.test("import type { z } from 'zod';"));
	assert.isFalse(ZOD_VALUE_IMPORT.test("import { x } from 'zodiac';"));
});
