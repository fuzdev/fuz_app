/**
 * The request target conformance table, run against the TS readers directly:
 * every `query` row of `testing/cross_backend/request_target_conformance.json`
 * through `read_query_pairs`, every `param` row through `read_path_segment` —
 * the readers the route pipeline, the RPC `GET` and the WebSocket upgrade
 * read the target through.
 *
 * The Rust unit leg reads a byte-identical copy beside
 * `fuz_http::request_target`; the wire leg (`request_target_conformance_wire`
 * in `spine_suites.cross.test.ts`) sends the `wire` rows to every backend.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { read_path_segment, read_query_pairs } from '#lib/http/request_target.ts';
import {
	load_request_target_conformance,
	REQUEST_TARGET_CONFORMANCE_PLACEHOLDERS
} from '#lib/testing/cross_backend/request_target_conformance.ts';

const table = load_request_target_conformance();

describe('request target conformance', () => {
	test('every query row reads as the table says', () => {
		const failures: Array<string> = [];
		for (const row of table.query) {
			const read = read_query_pairs(row.query);
			const got = read.ok ? { pairs: read.value.map(([k, v]) => [k, v]) } : { refused: read.error };
			try {
				assert.deepStrictEqual(got, row.read);
			} catch {
				failures.push(
					`${row.name}: expected ${JSON.stringify(row.read)}, got ${JSON.stringify(got)}`
				);
			}
		}
		assert.ok(
			failures.length === 0,
			`${failures.length} of ${table.query.length} query rows disagree:\n${failures.join('\n')}`
		);
	});

	test('every param row reads as the table says', () => {
		const failures: Array<string> = [];
		for (const row of table.param) {
			const read = read_path_segment(row.segment);
			const got = read.ok ? { value: read.value } : { refused: read.error };
			try {
				assert.deepStrictEqual(got, row.read);
			} catch {
				failures.push(
					`${row.name}: expected ${JSON.stringify(row.read)}, got ${JSON.stringify(got)}`
				);
			}
		}
		assert.ok(
			failures.length === 0,
			`${failures.length} of ${table.param.length} param rows disagree:\n${failures.join('\n')}`
		);
	});

	test('both refusals appear in both sections, and each section has decoded rows', () => {
		for (const [section, rows] of [
			['query', table.query],
			['param', table.param]
		] as const) {
			const refusals = new Set(
				rows.flatMap((row) => ('refused' in row.read ? [row.read.refused] : []))
			);
			assert.deepStrictEqual([...refusals].sort(), ['invalid_utf8', 'malformed_escape'], section);
			assert.ok(
				rows.some((row) => !('refused' in row.read)),
				`${section} has a row that decodes`
			);
		}
	});

	test('every wire target names only known placeholders', () => {
		for (const row of table.wire) {
			for (const [, name] of row.target.matchAll(/\{([a-z_]+)\}/g)) {
				assert.include(REQUEST_TARGET_CONFORMANCE_PLACEHOLDERS, name, row.name);
			}
		}
	});
});
