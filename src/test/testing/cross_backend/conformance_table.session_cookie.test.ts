import { assert, describe, test } from 'vitest';

import {
	assert_session_cookie,
	is_ws_conformance_case
} from '#lib/testing/cross_backend/conformance_table.ts';
import type { ConformanceCase } from '#lib/testing/cross_backend/conformance_case.ts';
import { format_session_set_cookie } from '#lib/auth/session_cookie.ts';

const NAME = 'fuz_session';
const MINT = format_session_set_cookie(NAME, 'tok:1700000000.sig', 60);

const row = (set_cookie?: ConformanceCase['expect']['set_cookie']): ConformanceCase => ({
	name: 'a row',
	request: { method: 'account_verify', as: 'anonymous' },
	expect: { status: 401, ...(set_cookie && { set_cookie }) }
});

describe('assert_session_cookie', () => {
	test('a refusal that mints fails the floor, whatever the row expects', () => {
		assert.throws(
			() => assert_session_cookie({ status: 401, set_cookies: [MINT] }, row('set'), NAME),
			/a 401 refusal minted a session cookie/
		);
	});

	test('a malformed mint on a refusal fails the floor too', () => {
		assert.throws(
			() => assert_session_cookie({ status: 403, set_cookies: [`${NAME}=x`] }, row(), NAME),
			/a 403 refusal minted a session cookie/
		);
	});

	test('a success may mint', () => {
		assert_session_cookie({ status: 200, set_cookies: [MINT] }, row('set'), NAME);
	});

	test('an omitted expectation is none', () => {
		assert_session_cookie({ status: 401, set_cookies: ['other=1'] }, row(), NAME);
		assert.throws(
			() =>
				assert_session_cookie(
					{
						status: 401,
						set_cookies: [`${NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`]
					},
					row(),
					NAME
				),
			/session cookie effect/
		);
	});
});

describe('is_ws_conformance_case', () => {
	const keeper_row = (set_cookie?: ConformanceCase['expect']['set_cookie']): ConformanceCase => ({
		name: 'a keeper row',
		request: { method: 'account_verify', as: 'keeper' },
		expect: { status: 200, ...(set_cookie && { set_cookie }) }
	});

	test('a row pinning no cookie effect runs over WS', () => {
		assert.ok(is_ws_conformance_case(keeper_row()));
		assert.ok(is_ws_conformance_case(keeper_row('none')));
	});

	test('a row pinning a cookie effect does not: a frame has no headers', () => {
		for (const effect of ['clear', 'set', 'clear_then_set'] as const) {
			assert.ok(!is_ws_conformance_case(keeper_row(effect)), effect);
		}
	});

	test('a dead credential cannot hold a socket', () => {
		for (const as of [
			'tampered_cookie',
			'wrong_daemon',
			'unknown_bearer',
			'revoked_session',
			'revoked_token',
			'expired_token'
		] as const) {
			assert.ok(
				!is_ws_conformance_case({ ...keeper_row(), request: { method: 'account_verify', as } }),
				as
			);
		}
	});
});
