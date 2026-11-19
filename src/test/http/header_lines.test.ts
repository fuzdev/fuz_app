/**
 * Tests for `http/header_lines.ts` — a request header as the lines it was
 * sent in, from `@hono/node-server`'s raw header list where there is one and
 * from the Fetch `Headers` value where there is none.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { Hono } from 'hono';

import { get_header_lines, trim_optional_whitespace } from '#lib/http/header_lines.ts';

/** An app answering the lines of the headers named in `?names=`. */
const create_app = (): Hono => {
	const app = new Hono();
	app.get('/lines', (c) => {
		const names = (c.req.query('names') ?? '').split(',');
		return c.json(Object.fromEntries(names.map((name) => [name, get_header_lines(c, name)])));
	});
	return app;
};

const read = async (
	names: Array<string>,
	headers: Record<string, string>,
	env?: object
): Promise<Record<string, Array<string>>> => {
	const res = await create_app().request(`/lines?names=${names.join(',')}`, { headers }, env);
	return res.json();
};

describe('get_header_lines', () => {
	test('without a raw view, the Fetch value is the single line', async () => {
		const lines = await read(['authorization', 'cookie', 'x-absent'], {
			Authorization: 'Bearer a',
			Cookie: 'a=1; b=2'
		});
		assert.deepStrictEqual(lines, {
			authorization: ['Bearer a'],
			cookie: ['a=1; b=2'],
			'x-absent': []
		});
	});

	test('an empty header is one empty line, not an absent header', async () => {
		const lines = await read(['x-daemon-token'], { 'X-Daemon-Token': '' });
		assert.deepStrictEqual(lines, { 'x-daemon-token': [''] });
	});

	test("with Node's raw header list, a repeated header is its lines", async () => {
		// the Fetch headers here are what `@hono/node-server` builds for a
		// WebSocket upgrade: Node's deduplicated view, the first line alone
		const lines = await read(
			['authorization', 'cookie', 'x-daemon-token', 'x-absent'],
			{ Authorization: 'Bearer first' },
			{
				incoming: {
					rawHeaders: [
						'Authorization',
						'Bearer first',
						'AUTHORIZATION',
						'Bearer second',
						'Cookie',
						'a=1',
						'cookie',
						'b=2',
						'X-Daemon-Token',
						' \tpadded\t '
					]
				}
			}
		);
		assert.deepStrictEqual(lines, {
			authorization: ['Bearer first', 'Bearer second'],
			cookie: ['a=1', 'b=2'],
			'x-daemon-token': ['padded'],
			'x-absent': []
		});
	});

	test('an env that is no Node request falls back to the Fetch value', async () => {
		for (const env of [
			{},
			{ incoming: null },
			{ incoming: {} },
			{ incoming: { rawHeaders: 'Authorization' } },
			{ incoming: { rawHeaders: ['Authorization'] } },
			{ incoming: { rawHeaders: ['Authorization', 1] } }
		]) {
			const lines = await read(['authorization'], { Authorization: 'Bearer a' }, env);
			assert.deepStrictEqual(lines, { authorization: ['Bearer a'] }, JSON.stringify(env));
		}
	});
});

describe('trim_optional_whitespace', () => {
	const cases: Array<[label: string, input: string, expected: string]> = [
		['SP and HTAB at both ends', ' \t a b \t ', 'a b'],
		['nothing to trim', 'a', 'a'],
		['only whitespace', ' \t ', ''],
		['empty', '', ''],
		['U+00A0 is kept', ' a ', ' a '],
		['LF, VT, FF and CR are kept', '\n\u000b\u000c\ra', '\n\u000b\u000c\ra'],
		['U+0085 and U+FEFF are kept', '\u0085a﻿', '\u0085a﻿']
	];
	test.each(cases)('%s', (_label, input, expected) => {
		assert.strictEqual(trim_optional_whitespace(input), expected);
	});
});
