/**
 * Conformance cases for an own `__proto__` key in `params`.
 *
 * JSON gives `{"__proto__": …}` an ordinary own key, and both spines must see
 * it as one: a `z.void()` input refuses it like any declared key, and a strict
 * input refuses it as unknown, on every transport — the POST cases run over
 * the WebSocket leg too. The params are built with `JSON.parse`, since an
 * object literal's `__proto__` sets the prototype instead of a key.
 *
 * @module
 */

import type { ConformanceCase } from '#lib/testing/cross_backend/conformance_case.ts';

/** `{"__proto__": {"acting": "x"}}` as an own key, the shape a client sends. */
const own_proto = (): unknown => JSON.parse('{"__proto__":{"acting":"x"}}');

export const conformance_proto_params_cases: ReadonlyArray<ConformanceCase> = [
	{
		name: 'keeper → account_verify with an own __proto__ params key → 400',
		request: { method: 'account_verify', as: 'keeper', params: own_proto() },
		expect: { status: 400 },
		note: 'a void input refuses the key like any other, rather than reading the params as {}'
	},
	{
		name: 'keeper → account_session_list via GET with an own __proto__ params key → 400',
		request: { method: 'account_session_list', as: 'keeper', params: own_proto(), verb: 'GET' },
		expect: { status: 400 },
		note: 'the GET query path refuses it as the POST body does'
	},
	{
		name: 'keeper → role_grant_offer_list with an own __proto__ params key → 400',
		request: { method: 'role_grant_offer_list', as: 'keeper', params: own_proto() },
		expect: { status: 400 },
		note: 'a strict input refuses it as an unknown key'
	},
	{
		name: 'keeper → role_grant_offer_list via GET with an own __proto__ params key → 400',
		request: { method: 'role_grant_offer_list', as: 'keeper', params: own_proto(), verb: 'GET' },
		expect: { status: 400 },
		note: 'the GET query path refuses it as the POST body does'
	}
];
