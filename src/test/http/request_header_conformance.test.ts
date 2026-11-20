/**
 * The request header conformance table, run against the TS readers directly:
 * every row of `testing/cross_backend/request_header_conformance.json` through
 * `read_origin`, `is_browser_context`, `read_host` and `read_content_type` —
 * the readers the origin check, the bearer and daemon-token legs, the host
 * gate and the content-type check call. Every row is also held
 * join-invariant: the same readings over the row's lines folded to one line
 * per name, the view Bun and an in-process `app.request` give.
 *
 * The Rust unit leg reads a byte-identical copy beside
 * `fuz_http::request_headers`; the wire leg (`request_header_conformance_wire`
 * in `spine_suites.cross.test.ts`) sends the rows to every backend.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import {
	is_browser_context,
	read_content_type,
	read_host,
	read_origin
} from '#lib/http/request_headers.ts';
import {
	fill_request_header_conformance_placeholders,
	fill_request_header_conformance_read,
	fold_header_lines,
	load_request_header_conformance,
	REQUEST_HEADER_CONFORMANCE_PLACEHOLDERS,
	request_header_values,
	to_request_header_conformance_read,
	type RequestHeaderConformanceRow
} from '#lib/testing/cross_backend/request_header_conformance.ts';

const table = load_request_header_conformance();
const placeholders = table.unit_placeholders;

/** Every reader's reading of `lines`, in the table's spelling. */
const read_lines = (lines: ReadonlyArray<string>): RequestHeaderConformanceRow['read'] => ({
	origin: to_request_header_conformance_read(read_origin(request_header_values(lines, 'origin'))),
	browser_context: is_browser_context(
		request_header_values(lines, 'origin'),
		request_header_values(lines, 'referer')
	),
	host: to_request_header_conformance_read(read_host(request_header_values(lines, 'host'))),
	content_type: to_request_header_conformance_read(
		read_content_type(request_header_values(lines, 'content-type'))
	)
});

const fill_lines = (row: RequestHeaderConformanceRow): Array<string> =>
	row.lines.map((line) => fill_request_header_conformance_placeholders(line, placeholders));

describe('request header conformance', () => {
	test('every row reads as the table says', () => {
		const failures: Array<string> = [];
		for (const row of table.rows) {
			const expected = {
				origin: fill_request_header_conformance_read(row.read.origin, placeholders),
				browser_context: row.read.browser_context,
				host: fill_request_header_conformance_read(row.read.host, placeholders),
				content_type: fill_request_header_conformance_read(row.read.content_type, placeholders)
			};
			const got = read_lines(fill_lines(row));
			try {
				assert.deepStrictEqual(got, expected);
			} catch {
				failures.push(
					`${row.name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`
				);
			}
		}
		assert.ok(
			failures.length === 0,
			`${failures.length} of ${table.rows.length} rows disagree:\n${failures.join('\n')}`
		);
	});

	test('every row reads the same over its lines folded to one line per name', () => {
		const failures: Array<string> = [];
		let folded_rows = 0;
		for (const row of table.rows) {
			const lines = fill_lines(row);
			const folded = fold_header_lines(lines);
			if (folded.length !== lines.length) folded_rows++;
			const by_line = read_lines(lines);
			const by_fold = read_lines(folded);
			try {
				assert.deepStrictEqual(by_fold, by_line);
			} catch {
				failures.push(
					`${row.name}: ${JSON.stringify(by_line)} over the lines, ` +
						`${JSON.stringify(by_fold)} over ${JSON.stringify(folded)}`
				);
			}
		}
		assert.ok(failures.length === 0, `rows not join-invariant:\n${failures.join('\n')}`);
		// a fold that changes no row would hold every row equal to itself
		assert.ok(folded_rows > 0, 'no row repeats a header, so the fold changed nothing');
	});

	test('the unit placeholders name every placeholder', () => {
		assert.deepStrictEqual(
			Object.keys(placeholders).sort(),
			[...REQUEST_HEADER_CONFORMANCE_PLACEHOLDERS].sort()
		);
	});

	test('the fold joins repeats in first-occurrence order and leaves single lines alone', () => {
		assert.deepStrictEqual(
			fold_header_lines([
				'Origin: a',
				'Host: h',
				'origin:',
				'ORIGIN: b',
				'Cookie: x=1',
				'Cookie: y=2'
			]),
			['Origin: a, , b', 'Host: h', 'Cookie: x=1; y=2']
		);
		assert.deepStrictEqual(fold_header_lines(['Content-Type: a/b', 'Content-Type:']), [
			'Content-Type: a/b,'
		]);
	});
});
