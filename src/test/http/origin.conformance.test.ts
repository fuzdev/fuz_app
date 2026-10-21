/**
 * The origin allowlist conformance table, run against the TS twin directly:
 * every row of `testing/cross_backend/origin_conformance.json` through
 * `run_testing_origin_check` — the function the `_testing_origin_check`
 * action serves, over `parse_allowed_origins` and `should_allow_origin`. The
 * cross-process leg (`cross_backend/origin_conformance.cross.test.ts`) sends
 * the same rows to every backend.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import {
	ALLOWED_ORIGINS_ERROR_MESSAGES,
	AllowedOriginsErrorKind,
	parse_allowed_origins
} from '#lib/http/origin.ts';
import {
	assert_origin_conformance,
	load_origin_conformance,
	to_origin_conformance_checks
} from '#lib/testing/cross_backend/origin_conformance.ts';
import { run_testing_origin_check } from '#lib/testing/cross_backend/testing_origin_check.ts';

const table = load_origin_conformance();
const checks = to_origin_conformance_checks(table);

describe('origin conformance table', () => {
	test('every row gets the answer it names', () => {
		assert_origin_conformance(
			checks,
			checks.map((check) => run_testing_origin_check(check.input)),
			'ts'
		);
	});

	test('every refusal kind appears in the table', () => {
		const seen = new Set(
			table.parse.flatMap((row) => ('errors' in row ? row.errors.map((e) => e.kind) : []))
		);
		for (const kind of AllowedOriginsErrorKind.options) {
			assert.ok(seen.has(kind), `no parse row is refused with ${kind}`);
		}
	});

	test('every match row names a valid allowlist', () => {
		for (const row of table.match) {
			assert.ok(parse_allowed_origins(row.patterns).ok, row.patterns);
		}
	});

	test('rows are unique within each table', () => {
		const raws = table.parse.map((row) => row.raw);
		assert.strictEqual(new Set(raws).size, raws.length, 'duplicate parse row');
		const pairs = table.match.map((row) => JSON.stringify([row.patterns, row.origin]));
		assert.strictEqual(new Set(pairs).size, pairs.length, 'duplicate match row');
	});

	test('every refusal kind has a message', () => {
		for (const kind of AllowedOriginsErrorKind.options) {
			assert.ok(ALLOWED_ORIGINS_ERROR_MESSAGES[kind], kind);
		}
	});
});
