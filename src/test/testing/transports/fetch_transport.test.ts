/**
 * Tests for `testing/transports/fetch_transport.ts` — the cookie jar the
 * cross-process suites thread their sessions through.
 *
 * @module
 */

import { afterEach, assert, describe, test, vi } from 'vitest';

import { create_fetch_transport } from '#lib/testing/transports/fetch_transport.ts';

const BASE_URL = 'http://localhost:1';

/** Stub `fetch` to answer each call with the next `Set-Cookie` list, recording the `Cookie` sent. */
const stub_fetch = (responses: Array<Array<string>>): Array<string | null> => {
	const sent: Array<string | null> = [];
	vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
		sent.push(new Headers(init?.headers).get('cookie'));
		const headers = new Headers();
		for (const set_cookie of responses.shift() ?? []) headers.append('set-cookie', set_cookie);
		return Promise.resolve(new Response(null, { headers }));
	});
	return sent;
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe('create_fetch_transport cookie jar', () => {
	test('a set cookie is kept and re-sent; a later one of its name replaces it', async () => {
		const sent = stub_fetch([['s=one; Path=/; Max-Age=60'], ['s=two; Path=/'], []]);
		const transport = create_fetch_transport({ base_url: BASE_URL });
		await transport('/a', {});
		await transport('/b', {});
		await transport('/c', {});
		assert.deepStrictEqual(sent, [null, 's=one', 's=two']);
		assert.deepStrictEqual(transport.cookies(), ['s=two']);
	});

	test('a cookie cleared with Max-Age=0 is dropped, not kept as an empty value', async () => {
		const sent = stub_fetch([
			['s=one; Path=/; Max-Age=60', 'other=1'],
			['s=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'],
			[]
		]);
		const transport = create_fetch_transport({ base_url: BASE_URL });
		await transport('/login', {});
		await transport('/logout', {});
		await transport('/after', {});
		// an empty `s=` re-sent would read as an invalid session cookie
		assert.deepStrictEqual(sent, [null, 's=one; other=1', 'other=1']);
		assert.deepStrictEqual(transport.cookies(), ['other=1']);
	});

	test('a clear then a set in one response leaves the new cookie', async () => {
		const sent = stub_fetch([['s=; Max-Age=0', 's=fresh; Max-Age=60'], []]);
		const transport = create_fetch_transport({
			base_url: BASE_URL,
			initial_cookies: ['s=stale']
		});
		await transport('/login', {});
		await transport('/after', {});
		assert.deepStrictEqual(sent, ['s=stale', 's=fresh']);
	});

	const kept: Array<[label: string, set_cookie: string]> = [
		['a positive Max-Age', 's=v; Max-Age=1'],
		['no Max-Age', 's=v; Path=/'],
		['a Max-Age that is no integer', 's=v; Max-Age=soon'],
		['an empty value with no Max-Age', 's=; Path=/']
	];
	test.each(kept)('%s keeps the cookie', async (_label, set_cookie) => {
		stub_fetch([[set_cookie]]);
		const transport = create_fetch_transport({ base_url: BASE_URL });
		await transport('/a', {});
		assert.strictEqual(transport.cookies().length, 1);
	});

	test.each(['s=v; Max-Age=0', 's=v; max-age=0', 's=v; Path=/; MAX-AGE = -1'])(
		'%s deletes the cookie',
		async (set_cookie) => {
			stub_fetch([[set_cookie]]);
			const transport = create_fetch_transport({
				base_url: BASE_URL,
				initial_cookies: ['s=old', 'other=1']
			});
			await transport('/a', {});
			assert.deepStrictEqual(transport.cookies(), ['other=1']);
		}
	);
});
