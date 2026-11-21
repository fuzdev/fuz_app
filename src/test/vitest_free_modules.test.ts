/**
 * Import-graph gate: the modules a spawned process loads stay free of
 * `vitest`.
 *
 * The TS spine binary runs outside vitest, so a value import of `vitest`
 * anywhere in its static graph throws when it starts, and so does a consumer's
 * own test binary built on the same modules (fuz_forge's server build imports
 * `testing/app_server.ts`). Nothing in a vitest run notices, since vitest is
 * loaded there. `VITEST_FREE` names the roots that must stay free — the spine
 * binary's entries and the shared modules a test binary mounts — and this
 * walks each one's graph. Every entry must exist, so a renamed or deleted
 * module fails here rather than leaving a stale name that checks nothing.
 *
 * Same walk as `hono_free_modules.test.ts`: a whole-statement `import type` /
 * `export type` is erased and skipped, any other static import or re-export is
 * followed, dynamic `import()` is not, and a relative or `#lib/` specifier that
 * resolves to no file fails the walk.
 *
 * @module
 */

import { test, assert, describe } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

/** Absolute path to `src`, resolved relative to this test. */
const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Absolute path to `src/lib`, the target of `#lib/` specifiers. */
const LIB_DIR = join(SRC_DIR, 'lib');

/** Modules whose static graph must not reach vitest, relative to `src`. */
const VITEST_FREE: ReadonlySet<string> = new Set([
	// the TS spine binary's entries
	'test/cross_backend/testing_spine_server_node.ts',
	'test/cross_backend/testing_spine_server_bun.ts',
	// the shared modules a test binary mounts
	'lib/testing/app_server.ts',
	'lib/testing/db.ts',
	'lib/testing/db_invariant_queries.ts',
	'lib/testing/cross_backend/testing_reset_actions.ts'
]);

/** A static `import` / `export … from` statement; group 1 is `type `, group 2 the specifier. */
const STATIC_IMPORT = /^\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;

const VITEST_SPECIFIER = /^(?:vitest(?:\/|$)|@vitest\/)/;

/** Module extensions the walk follows; other in-repo targets (JSON, CSS) are leaves. */
const MODULE_EXTENSION = /\.(?:ts|svelte)$/;

/** The static, value-carrying imports of `file`. */
const value_imports = (file: string): Array<string> => {
	const specifiers: Array<string> = [];
	for (const match of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) {
		if (!match[1]) specifiers.push(match[2]!);
	}
	return specifiers;
};

/** Resolve an in-repo specifier to an absolute path, `null` for a package import. */
const resolve_local = (from: string, specifier: string): string | null => {
	if (specifier.startsWith('.')) return resolve(dirname(from), specifier);
	if (specifier.startsWith('#lib/')) return join(LIB_DIR, specifier.slice('#lib/'.length));
	return null;
};

interface VitestWalk {
	/** Every vitest value import reachable, each as its chain (`a.ts → b.ts → vitest`). */
	chains: Array<string>;
	/** In-repo specifiers that resolve to no file, as `module → specifier`. */
	unresolved: Array<string>;
}

/** Walk the static value-import graph from `entry`. */
const walk_vitest = (entry: string): VitestWalk => {
	const parent: Map<string, string | null> = new Map([[entry, null]]);
	const chains: Array<string> = [];
	const unresolved: Array<string> = [];
	const chain_to = (file: string): Array<string> => {
		const path: Array<string> = [];
		for (let f: string | null = file; f !== null; f = parent.get(f) ?? null) {
			path.unshift(relative(SRC_DIR, f));
		}
		return path;
	};
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.shift()!;
		for (const specifier of value_imports(file)) {
			if (VITEST_SPECIFIER.test(specifier)) {
				chains.push([...chain_to(file), specifier].join(' → '));
				continue;
			}
			const target = resolve_local(file, specifier);
			if (target === null) continue;
			if (!existsSync(target)) {
				unresolved.push(`${relative(SRC_DIR, file)} → ${specifier}`);
				continue;
			}
			if (MODULE_EXTENSION.test(target) && !parent.has(target)) {
				parent.set(target, file);
				queue.push(target);
			}
		}
	}
	return { chains, unresolved };
};

describe('the modules a spawned process loads reach no vitest value import', () => {
	for (const module of VITEST_FREE) {
		test(module, () => {
			const file = join(SRC_DIR, module);
			// a stale entry would check nothing
			assert.ok(existsSync(file), `${module} is listed but missing`);
			const { chains, unresolved } = walk_vitest(file);
			assert.deepStrictEqual(unresolved, [], 'unresolved in-repo imports');
			assert.deepStrictEqual(chains, []);
		});
	}
});
