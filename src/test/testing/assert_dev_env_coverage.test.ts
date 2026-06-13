/**
 * Coverage gate for the production-exclusion guard.
 *
 * `assert_dev_env.test.ts` proves the guard *throws* under `DEV=false`; this
 * test proves every runtime-reachable module under `src/lib/testing/`
 * actually *carries* it. That per-module property is asserted by both
 * `testing/CLAUDE.md` and `docs/security.md` §Test Backdoor Actions
 * ("Excluded from production builds — every module in the testing tree begins
 * with a load-time `assert_dev_env` guard"), but nothing enforced it: a new
 * testing module that forgot the side-effect import would ship the backdoor
 * (deterministic dev secrets, the `_testing_*` action specs, the fast Argon2
 * stub) into a production bundle without crashing on import. This
 * characterization test fails loud instead.
 *
 * The guard must be the file's **first statement** — it runs at module
 * evaluation, before any other import's side effects could execute. Two
 * modules are exempt:
 *
 *   - `assert_dev_env.ts` — it *is* the guard.
 *   - `cross_backend/make_cross_backend_project.ts` — a vitest-project factory
 *     consumed by consumers' `vite.config.ts` at *config* time, never reached
 *     by runtime/application code. A throwing guard there would fire during
 *     `vite build` (`NODE_ENV=production` → `esm-env` `DEV=false`) and break
 *     the consumer's build. The guard protects shipped runtime bundles; a
 *     build-config helper is a different category.
 *
 * @module
 */

import {test, assert, describe} from 'vitest';
import {readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

/** Absolute path to `src/lib/testing`, resolved relative to this test. */
const TESTING_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../lib/testing');

/** Modules that legitimately omit the guard (see the module doc). */
const EXEMPT: ReadonlySet<string> = new Set([
	'assert_dev_env.ts',
	'cross_backend/make_cross_backend_project.ts',
]);

/**
 * The guard import, at any nesting depth: `import './assert_dev_env.js';`,
 * `import '../assert_dev_env.js';`, `import '../../assert_dev_env.js';`, …
 */
const GUARD_IMPORT = /^import\s+['"](?:\.\.?\/)+assert_dev_env\.js['"];?$/;

/** Every `.ts` module under `src/lib/testing`, posix-relative + sorted. */
const list_testing_modules = (): Array<string> =>
	readdirSync(TESTING_DIR, {recursive: true, encoding: 'utf8'})
		.filter((p) => p.endsWith('.ts'))
		.map((p) => p.split('\\').join('/'))
		.sort();

/**
 * First non-blank, non-comment line of `src` — block comments (the leading
 * `@module` doc) and `//` lines are skipped, so example `import` lines inside
 * TSDoc can't masquerade as the first statement.
 */
const first_code_line = (src: string): string => {
	let in_block = false;
	for (const raw of src.split('\n')) {
		const line = raw.trim();
		if (in_block) {
			if (line.includes('*/')) in_block = false;
			continue;
		}
		if (line.startsWith('/*')) {
			if (!line.includes('*/')) in_block = true;
			continue;
		}
		if (line === '' || line.startsWith('//')) continue;
		return line;
	}
	return '';
};

describe('every testing module carries the assert_dev_env guard', () => {
	const modules = list_testing_modules();

	test('found a non-trivial set of modules (guards against a path regression)', () => {
		assert.isAbove(
			modules.length,
			50,
			`expected many testing modules under ${TESTING_DIR}, found ${modules.length} — did the path break?`,
		);
	});

	for (const rel of modules) {
		if (EXEMPT.has(rel)) continue;
		test(rel, () => {
			const first = first_code_line(readFileSync(join(TESTING_DIR, rel), 'utf8'));
			assert.match(
				first,
				GUARD_IMPORT,
				`${rel}: first statement must be the production-exclusion guard ` +
					`(\`import './assert_dev_env.js';\`), got: ${JSON.stringify(first)}`,
			);
		});
	}

	test('exempt modules still exist (allowlist stays honest)', () => {
		for (const rel of EXEMPT) {
			assert.include(modules, rel, `exempt module no longer exists: ${rel} — prune the allowlist`);
		}
	});
});
