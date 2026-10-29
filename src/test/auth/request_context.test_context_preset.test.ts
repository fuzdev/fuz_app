/**
 * Drift guard for `TEST_CONTEXT_PRESET_KEY`, and the pin that only the
 * `TEST_CONTEXT_PRESET` symbol sets it.
 *
 * The flag is the dispatcher's test-only escape hatch — when set,
 * `apply_authorization_phase` short-circuits and trusts whatever the
 * harness pre-populated under `REQUEST_CONTEXT_KEY`. Production
 * middleware setting it would silently bypass the live actor +
 * role_grant resolution, so we walk the source tree at test time and
 * fail loud on any production-side write to that key.
 *
 * Allowed write sites are confined to `src/lib/testing/` — those are
 * the harness helpers (`auth_apps.ts`, `middleware.ts`, the WS
 * round-trip primitives) that consumers opt into by importing. The value
 * is a symbol, so a string or `true` that reaches the key some other way
 * (a misconfigured context variable, say) does not preset.
 *
 * @module
 */

import { test, assert } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';

import {
	has_test_context_preset,
	RESOLVED_AUTH_KEY,
	TEST_CONTEXT_PRESET,
	TEST_CONTEXT_PRESET_KEY
} from '#lib/hono_context.ts';
import { run_authorization_phase } from '#lib/auth/request_context.ts';
import { Db } from '#lib/db/db.ts';
import { create_uuid } from '#lib/primitive_schemas.ts';
import { create_test_resolved_auth } from '#lib/testing/resolved_auth.ts';

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
 * Files that own the canonical declaration of the key, the symbol, and the
 * one reader (`has_test_context_preset`) — exempt from every pattern below.
 */
const DECLARATION_PATHS = new Set<string>([`${LIB_ROOT}hono_context.ts`]);

test('no production module under src/lib/ writes TEST_CONTEXT_PRESET_KEY or reads it directly', () => {
	// The flag value is `'test_context_preset'` — keep this in sync if
	// the constant is ever renamed (the test doubles as a rename guard).
	assert.strictEqual(TEST_CONTEXT_PRESET_KEY, 'test_context_preset');

	// Patterns that would set the key on a Hono context — both the named
	// constant and the bare string literal — or read it other than through
	// `has_test_context_preset`, whose symbol comparison is what keeps a
	// truthy non-preset value from passing.
	const set_patterns: Array<RegExp> = [
		/\.get\s*\(\s*TEST_CONTEXT_PRESET_KEY\b/,
		/\.get\s*\(\s*['"]test_context_preset['"]/,
		/c\.set\s*\(\s*TEST_CONTEXT_PRESET_KEY\b/,
		/c\.set\s*\(\s*['"]test_context_preset['"]/,
		// Initial-var maps (`{[TEST_CONTEXT_PRESET_KEY]: ...}` or `{test_context_preset: ...}`)
		// the WS round-trip fake context uses — allowed in `testing/`,
		// banned everywhere else under `src/lib/`.
		/\[\s*TEST_CONTEXT_PRESET_KEY\s*\]\s*:/,
		/\btest_context_preset\s*:\s*(?:true|false|[a-zA-Z_])/,
		// the preset value itself, outside a backticked doc mention — production
		// reads the flag only through `has_test_context_preset`, so code naming
		// the symbol is a write in waiting
		/(?<!`)\bTEST_CONTEXT_PRESET\b(?!`)/
	];

	const violations: Array<{ file: string; pattern: string; line: string }> = [];

	for (const file of walk(LIB_ROOT)) {
		// Skip the testing subtree — the escape-hatch setters live there.
		if (file.startsWith(TESTING_PREFIX)) continue;
		// Skip generated files and non-TS sources.
		if (!/\.(ts|js)$/.test(file)) continue;

		const text = readFileSync(file, 'utf8');
		for (const pattern of set_patterns) {
			const m = pattern.exec(text);
			if (m) {
				// `hono_context.ts` declares the constant, the symbol, the type
				// entry, and the reader — not writes
				if (DECLARATION_PATHS.has(file)) continue;
				violations.push({ file, pattern: pattern.source, line: m[0] });
			}
		}
	}

	assert.deepStrictEqual(
		violations,
		[],
		`Production code under src/lib/ must not write TEST_CONTEXT_PRESET_KEY, and reads it ` +
			`only through has_test_context_preset. Move a write to src/lib/testing/. Violations:\n` +
			violations.map((v) => `  ${v.file}: ${v.line} (matched ${v.pattern})`).join('\n')
	);
});

test('only the `TEST_CONTEXT_PRESET` symbol sets the preset', () => {
	const read = (value: unknown): boolean => {
		const vars: Record<string, unknown> = { [TEST_CONTEXT_PRESET_KEY]: value };
		return has_test_context_preset({ get: (key: string) => vars[key] } as never);
	};
	assert.strictEqual(read(TEST_CONTEXT_PRESET), true);
	const others: Array<unknown> = [
		undefined,
		null,
		true,
		1,
		'test_context_preset',
		'true',
		{},
		Symbol('test_context_preset'),
		Symbol.for('test_context_preset')
	];
	for (const [i, value] of others.entries()) {
		assert.strictEqual(read(value), false, `value ${i} is not the preset`);
	}
});

test('a truthy non-preset value under the key runs the live authorization phase', async () => {
	// the phase reads the database when it runs and skips it under the
	// preset, so a query count tells the two apart
	let queries = 0;
	const db: Db = new Db({
		client: {
			query: () => {
				queries++;
				return Promise.resolve({ rows: [] });
			}
		},
		transaction: (fn) => fn(db)
	});
	const account_id = create_uuid();
	const statuses = async (value: unknown): Promise<number> => {
		const app = new Hono();
		app.get('/test', async (c) => {
			c.set(
				RESOLVED_AUTH_KEY,
				create_test_resolved_auth({ credential_type: 'session', account_id })
			);
			(c as any).set(TEST_CONTEXT_PRESET_KEY, value);
			const refused = await run_authorization_phase(
				c,
				{ db },
				{ account: 'required', actor: 'none' },
				undefined
			);
			return refused ?? c.json({ ok: true });
		});
		return (await app.request('/test')).status;
	};

	assert.strictEqual(await statuses(TEST_CONTEXT_PRESET), 200, 'the preset skips the phase');
	assert.strictEqual(queries, 0);
	for (const value of [true, 'test_context_preset']) {
		queries = 0;
		// the phase ran: the account read found nothing, a vanished account
		assert.strictEqual(await statuses(value), 500, `${String(value)} does not skip the phase`);
		assert.ok(queries > 0);
	}
});
