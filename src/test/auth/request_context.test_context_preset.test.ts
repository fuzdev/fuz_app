/**
 * Drift guard for `TEST_CONTEXT_PRESET_KEY`.
 *
 * The flag is the dispatcher's test-only escape hatch — when set,
 * `apply_authorization_phase` short-circuits and trusts whatever the
 * harness pre-populated under `REQUEST_CONTEXT_KEY`. Production
 * middleware setting it would silently bypass the live actor +
 * permit resolution, so we walk the source tree at test time and
 * fail loud on any production-side write to that key.
 *
 * Allowed write sites are confined to `src/lib/testing/` — those are
 * the harness helpers (`auth_apps.ts`, `middleware.ts`, the WS
 * round-trip primitives) that consumers opt into by importing.
 *
 * @module
 */

import {test, assert} from 'vitest';
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';

import {TEST_CONTEXT_PRESET_KEY} from '$lib/hono_context.js';

/** Walk a directory tree, yielding absolute paths of every regular file. */
const walk = (root: string): Array<string> => {
	const out: Array<string> = [];
	const visit = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			const s = statSync(full);
			if (s.isDirectory()) {
				visit(full);
			} else if (s.isFile()) {
				out.push(full);
			}
		}
	};
	visit(root);
	return out;
};

const LIB_ROOT = new URL('../../lib/', import.meta.url).pathname;
const TESTING_PREFIX = `${LIB_ROOT}testing/`;

/**
 * Files that own the canonical declaration of the key. Allowed to
 * mention the literal `'test_context_preset'` exactly once each
 * because they declare the constant + its Hono context-type entry —
 * checked in the second test below by counting only assignments.
 */
const DECLARATION_PATHS = new Set<string>([`${LIB_ROOT}hono_context.ts`]);

test('no production module under src/lib/ writes TEST_CONTEXT_PRESET_KEY', () => {
	// The flag value is `'test_context_preset'` — keep this in sync if
	// the constant is ever renamed (the test doubles as a rename guard).
	assert.strictEqual(TEST_CONTEXT_PRESET_KEY, 'test_context_preset');

	// Patterns that would set the key on a Hono context — both the named
	// constant and the bare string literal. Reads (`c.get(...)`) and
	// type-only mentions (e.g. the `ContextVariableMap` augmentation) are
	// allowed; only writes are forbidden in production code.
	const set_patterns: Array<RegExp> = [
		/c\.set\s*\(\s*TEST_CONTEXT_PRESET_KEY\b/,
		/c\.set\s*\(\s*['"]test_context_preset['"]/,
		// Initial-var maps (`{[TEST_CONTEXT_PRESET_KEY]: ...}` or `{test_context_preset: ...}`)
		// the WS round-trip fake context uses — allowed in `testing/`,
		// banned everywhere else under `src/lib/`.
		/\[\s*TEST_CONTEXT_PRESET_KEY\s*\]\s*:/,
		/\btest_context_preset\s*:\s*(?:true|false|[a-zA-Z_])/,
	];

	const violations: Array<{file: string; pattern: string; line: string}> = [];

	for (const file of walk(LIB_ROOT)) {
		// Skip the testing subtree — the escape-hatch setters live there.
		if (file.startsWith(TESTING_PREFIX)) continue;
		// Skip generated files and non-TS sources.
		if (!/\.(ts|js)$/.test(file)) continue;

		const text = readFileSync(file, 'utf8');
		for (const pattern of set_patterns) {
			const m = pattern.exec(text);
			if (m) {
				// `hono_context.ts` declares the constant + the type entry —
				// the type entry matches `\btest_context_preset\s*:\s*[a-zA-Z_]`
				// (the type is `boolean`) and is part of the canonical
				// declaration, not a write. The grep above already excludes
				// reads; this further excludes the declaration sites.
				if (DECLARATION_PATHS.has(file) && pattern.source.includes('test_context_preset')) {
					continue;
				}
				violations.push({file, pattern: pattern.source, line: m[0]});
			}
		}
	}

	assert.deepStrictEqual(
		violations,
		[],
		`Production code under src/lib/ must not write TEST_CONTEXT_PRESET_KEY. ` +
			`Move the write to src/lib/testing/, or remove it. Violations:\n` +
			violations.map((v) => `  ${v.file}: ${v.line} (matched ${v.pattern})`).join('\n'),
	);
});
