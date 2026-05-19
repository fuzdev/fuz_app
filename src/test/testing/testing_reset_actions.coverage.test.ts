/**
 * Static coverage check for `_testing_reset`.
 *
 * `_testing_reset` must DELETE from every table in
 * `auth_integration_truncate_tables` — that constant is the canonical
 * "auth tables a between-test reset must clear" list, and the handler's
 * SQL is inline (per-table scoping isn't uniform, so iterating the
 * constant wouldn't fit). This test enforces set-equality between the
 * handler's `DELETE FROM <table>` targets and the constant, so a future
 * auth migration that adds a table to `auth_integration_truncate_tables`
 * without updating `testing_reset_actions.ts` fails CI rather than
 * silently leaking rows across cross-process tests.
 *
 * @module
 */

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {test, assert} from 'vitest';

import {auth_integration_truncate_tables} from '$lib/testing/db.js';

const source_path = fileURLToPath(
	new URL('../../lib/testing/cross_backend/testing_reset_actions.ts', import.meta.url),
);

test('DELETE FROM targets match auth_integration_truncate_tables', () => {
	const source = readFileSync(source_path, 'utf-8');
	const targets = new Set([...source.matchAll(/DELETE FROM (\w+)/g)].map((m) => m[1]!));
	const canonical = new Set(auth_integration_truncate_tables);
	assert.deepStrictEqual(
		targets,
		canonical,
		`_testing_reset DELETE targets diverge from auth_integration_truncate_tables.\n` +
			`  only in _testing_reset: ${[...targets].filter((t) => !canonical.has(t)).join(', ') || '(none)'}\n` +
			`  only in canonical list: ${[...canonical].filter((t) => !targets.has(t)).join(', ') || '(none)'}`,
	);
});
