import { assert, describe, test } from 'vitest';

import {
	classify_session_cookie_effect,
	find_session_cookie_mints
} from '#lib/testing/cross_backend/session_cookie_effect.ts';

const NAME = 'fuz_session';
// literal copies of the spine's strings (`format_session_clear_cookie` /
// `format_session_set_cookie`), so the classifier is pinned to the bytes, not
// to whatever the formatters write
const CLEAR = 'fuz_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';
const MINT =
	'fuz_session=tok:1700000000.c2ln+/A=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000';

describe('classify_session_cookie_effect', () => {
	test('reads each effect off the session cookie lines alone', () => {
		assert.strictEqual(classify_session_cookie_effect([], NAME), 'none');
		assert.strictEqual(classify_session_cookie_effect(['other=1; Path=/'], NAME), 'none');
		assert.strictEqual(classify_session_cookie_effect([CLEAR], NAME), 'clear');
		assert.strictEqual(classify_session_cookie_effect(['other=1', MINT], NAME), 'set');
		assert.strictEqual(classify_session_cookie_effect([CLEAR, MINT], NAME), 'clear_then_set');
	});

	test('a cookie whose name only starts with the session name is not it', () => {
		assert.strictEqual(classify_session_cookie_effect([`${NAME}_x=1`], NAME), 'none');
	});

	test('a line off the formatters is no effect', () => {
		for (const lines of [
			// attribute order moved
			['fuz_session=; HttpOnly; Path=/; Secure; SameSite=Strict; Max-Age=0'],
			// an attribute dropped
			['fuz_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'],
			// an attribute added
			[`${CLEAR}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`],
			// a mint with no value or a non-positive age
			['fuz_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=60'],
			['fuz_session=v; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'],
			// two of one, or the clear after the mint
			[MINT, MINT],
			[CLEAR, CLEAR],
			[MINT, CLEAR],
			[CLEAR, MINT, CLEAR]
		]) {
			assert.strictEqual(classify_session_cookie_effect(lines, NAME), null, JSON.stringify(lines));
		}
	});
});

describe('find_session_cookie_mints', () => {
	test('a clear is no mint', () => {
		assert.deepEqual(find_session_cookie_mints([CLEAR], NAME), []);
	});

	test('a value or a positive age is a mint, in any shape', () => {
		const loose = 'fuz_session=v';
		const aged = 'fuz_session=; Max-Age=5';
		assert.deepEqual(find_session_cookie_mints([MINT, loose, aged, 'other=1'], NAME), [
			MINT,
			loose,
			aged
		]);
	});
});
