/**
 * Tests for `create_session_cookie_value`, `sign_session_cookie`, the
 * `Set-Cookie` formatters (`format_session_set_cookie`,
 * `format_session_clear_cookie`, and the cookie grammar predicates they guard
 * with) + module-level constants (`SESSION_AGE_MAX`,
 * `SESSION_COOKIE_ATTRIBUTES`, `SESSION_COOKIE_NAME`).
 *
 * The sibling `session_cookie.parse.test.ts` covers
 * `parse_session_from_cookies` and the round-trip.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import {
	create_session_cookie_value,
	format_session_clear_cookie,
	format_session_set_cookie,
	is_cookie_name,
	is_cookie_value,
	parse_session_from_cookies,
	SESSION_AGE_MAX,
	SESSION_COOKIE_ATTRIBUTES,
	SESSION_COOKIE_NAME,
	sign_session_cookie
} from '#lib/auth/session_cookie.ts';
import { create_test_keyring, TEST_IDENTITY } from './session_test_helpers.ts';

describe('session constants', () => {
	test('SESSION_AGE_MAX is 30 days in seconds', () => {
		const THIRTY_DAYS_SECONDS = 60 * 60 * 24 * 30;
		assert.strictEqual(SESSION_AGE_MAX, THIRTY_DAYS_SECONDS);
	});

	test('SESSION_AGE_MAX matches AUTH_SESSION_LIFETIME_MS exactly', async () => {
		// Strict equality: the cookie's signed-value lifetime and the DB
		// session's `expires_at` are paired by `query_session_touch`'s
		// extension model. If they drift, either DB sessions outlive cookies
		// (active user logged out while session is alive) or cookies outlive
		// DB sessions (cookie validates against a missing session row).
		const { AUTH_SESSION_LIFETIME_MS } = await import('#lib/auth/session_queries.ts');
		const db_lifetime_seconds = AUTH_SESSION_LIFETIME_MS / 1000;
		assert.strictEqual(
			SESSION_AGE_MAX,
			db_lifetime_seconds,
			`cookie SESSION_AGE_MAX (${
				SESSION_AGE_MAX
			}s) must equal DB AUTH_SESSION_LIFETIME_MS / 1000 (${db_lifetime_seconds}s)`
		);
	});
});

describe('session Set-Cookie strings', () => {
	// Literal copies of the Rust spine's strings (`format_session_set_cookie` /
	// `format_session_clear_cookie` in `fuz_auth`), which pins the same ones.
	test("the attributes are fixed, in the Rust spine's order", () => {
		assert.strictEqual(SESSION_COOKIE_ATTRIBUTES, 'Path=/; HttpOnly; Secure; SameSite=Strict');
	});

	test('set: the value verbatim, the attributes, then Max-Age', () => {
		assert.strictEqual(
			format_session_set_cookie('fuz_session', 'tok:1700000000.c2ln+/A=', 2592000),
			'fuz_session=tok:1700000000.c2ln+/A=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000'
		);
	});

	test('clear: an empty value and Max-Age=0', () => {
		assert.strictEqual(
			format_session_clear_cookie('fuz_session'),
			'fuz_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'
		);
	});

	test('a real signed value is written unencoded', async () => {
		const keyring = create_test_keyring();
		const value = await create_session_cookie_value(keyring, TEST_IDENTITY);
		assert.ok(is_cookie_value(value), 'a signed value is cookie-octets as it is');
		const header = format_session_set_cookie('fuz_session', value, SESSION_AGE_MAX);
		assert.ok(header.startsWith(`fuz_session=${value}; `), header);
		assert.ok(!header.includes('%'), 'nothing is percent-encoded');
	});

	const refused_values: Array<[label: string, value: string]> = [
		['a space', 'a b'],
		['a semicolon', 'a;b'],
		['a comma', 'a,b'],
		['a double quote', 'a"b'],
		['a backslash', 'a\\b'],
		['a control character', 'a\tb'],
		['DEL', 'a\x7fb'],
		['a non-ASCII character', 'a\u00e9b'],
		['a character above U+00FF', 'a\u0100']
	];
	test.each(refused_values)('set refuses a value holding %s', (_label, value) => {
		assert.strictEqual(is_cookie_value(value), false);
		assert.throws(() => format_session_set_cookie('fuz_session', value, 60), /cookie-octets/);
	});

	// the guards sit on a credential path and take a consumer's output: a
	// value that is no string is refused, never read as its text
	const non_strings: Array<[label: string, value: unknown]> = [
		['undefined', undefined],
		['null', null],
		['a number', 1],
		['an object', { toString: () => 'abc' }]
	];
	test.each(non_strings)('set refuses a value that is %s', (_label, value) => {
		assert.strictEqual(is_cookie_value(value as string), false);
		assert.throws(
			() => format_session_set_cookie('fuz_session', value as string, 60),
			/cookie-octets/
		);
	});
	test.each(non_strings)('set and clear refuse a name that is %s', (_label, name) => {
		assert.strictEqual(is_cookie_name(name as string), false);
		assert.throws(() => format_session_set_cookie(name as string, 'v', 60), /cookie-name/);
		assert.throws(() => format_session_clear_cookie(name as string), /cookie-name/);
	});

	test('a refusal never quotes the value', () => {
		try {
			format_session_set_cookie('fuz_session', 'secret value', 60);
		} catch (e) {
			assert(e instanceof Error);
			assert.ok(!e.message.includes('secret value'), e.message);
			return;
		}
		assert.fail('expected a throw');
	});

	const refused_names: Array<[label: string, name: string]> = [
		['empty', ''],
		['an equals sign', 'a=b'],
		['a space', 'a b'],
		['a semicolon', 'a;b'],
		['a non-ASCII character', 'caf\u00e9']
	];
	test.each(refused_names)('set and clear refuse a name that is %s', (_label, name) => {
		assert.strictEqual(is_cookie_name(name), false);
		assert.throws(() => format_session_set_cookie(name, 'v', 60), /cookie-name/);
		assert.throws(() => format_session_clear_cookie(name), /cookie-name/);
	});

	test('every token character is a cookie name; every cookie-octet a value', () => {
		assert.ok(is_cookie_name("!#$%&'*+-.^_`|~09AZaz"));
		let octets = '';
		for (let code = 0x21; code <= 0x7e; code++) {
			const char = String.fromCharCode(code);
			if (!'",;\\'.includes(char)) octets += char;
		}
		assert.ok(is_cookie_value(octets));
		assert.ok(is_cookie_value(''), 'the clear cookie writes an empty value');
	});

	test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		'set refuses a max_age of %s',
		(max_age) => {
			assert.throws(() => format_session_set_cookie('fuz_session', 'v', max_age), /max_age/);
		}
	);
});

describe('create_session_cookie_value', () => {
	test('produces a signed string with dot separator', async () => {
		const keyring = create_test_keyring();
		const value = await create_session_cookie_value(keyring, TEST_IDENTITY, 1000);
		assert.ok(value.includes('.'));
	});

	test('embeds expiration in the signed value', async () => {
		const keyring = create_test_keyring();
		const now = 1000;
		const signed = await create_session_cookie_value(keyring, TEST_IDENTITY, now);
		const result = await keyring.verify(signed);
		assert.ok(result);
		assert.ok(result.value.includes(`${now + SESSION_AGE_MAX}`));
	});

	test('embeds identity in the signed value', async () => {
		const keyring = create_test_keyring();
		const signed = await create_session_cookie_value(keyring, TEST_IDENTITY, 1000);
		const result = await keyring.verify(signed);
		assert.ok(result);
		assert.ok(result.value.startsWith(`${TEST_IDENTITY}:`));
	});

	test('different identities produce different values', async () => {
		const keyring = create_test_keyring();
		const now = 1000;
		const value1 = await create_session_cookie_value(keyring, 'user-1', now);
		const value2 = await create_session_cookie_value(keyring, 'user-2', now);
		assert.notStrictEqual(value1, value2);
	});

	test('same inputs produce same output (deterministic)', async () => {
		const keyring = create_test_keyring();
		const now = 1000;
		const value1 = await create_session_cookie_value(keyring, TEST_IDENTITY, now);
		const value2 = await create_session_cookie_value(keyring, TEST_IDENTITY, now);
		assert.strictEqual(value1, value2);
	});

	test('the expiry is SESSION_AGE_MAX past the mint', async () => {
		const keyring = create_test_keyring();
		const now = 1000;
		const signed = await create_session_cookie_value(keyring, TEST_IDENTITY, now);
		const result = await keyring.verify(signed);
		assert.ok(result);
		assert.strictEqual(result.value, `${TEST_IDENTITY}:${now + SESSION_AGE_MAX}`);
	});
});

describe('sign_session_cookie', () => {
	test('the Set-Cookie line of a freshly signed cookie, with SESSION_AGE_MAX as Max-Age', async () => {
		const keyring = create_test_keyring();
		const line = await sign_session_cookie(keyring, TEST_IDENTITY, 'test_session');
		const prefix = 'test_session=';
		const suffix = `; ${SESSION_COOKIE_ATTRIBUTES}; Max-Age=${SESSION_AGE_MAX}`;
		assert.ok(line.startsWith(prefix), line);
		assert.ok(line.endsWith(suffix), line);
		const value = line.slice(prefix.length, -suffix.length);
		const read = await parse_session_from_cookies(
			[`test_session=${value}`],
			keyring,
			'test_session'
		);
		assert.strictEqual(read.kind, 'valid');
		assert.strictEqual(read.kind === 'valid' && read.cookie.token, TEST_IDENTITY);
	});

	test('refuses a name that is no cookie-name', async () => {
		const keyring = create_test_keyring();
		await assert_rejects(() => sign_session_cookie(keyring, TEST_IDENTITY, 'a b'), /cookie-name/);
	});

	test("the default name is the Rust spine's SESSION_COOKIE_NAME", () => {
		assert.strictEqual(SESSION_COOKIE_NAME, 'fuz_session');
	});
});
