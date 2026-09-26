/**
 * Conformance cases for a `z.void()` input's accepted `params` shapes.
 *
 * JSON-RPC 2.0 lets a parameterless call omit `params`, and an empty by-name
 * structure carries no parameters, so both spines read an absent `params` and
 * a `{}` alike as the no-arg call and refuse a declared key with
 * `invalid_params`. Published WebSocket clients send `{}` for a parameterless
 * call — a spine that refused it would break every void method over WS.
 *
 * @module
 */

import type { ConformanceCase } from '$lib/testing/cross_backend/conformance_case.ts';

export const conformance_void_params_cases: ReadonlyArray<ConformanceCase> = [
	{
		name: 'keeper → account_verify with absent params → 200',
		request: { method: 'account_verify', as: 'keeper' },
		expect: { status: 200 },
		note: 'the absent form is the parameterless call'
	},
	{
		name: 'keeper → account_verify with params {} → 200',
		request: { method: 'account_verify', as: 'keeper', params: {} },
		expect: { status: 200 },
		note: 'an empty params object carries no parameters, so a void input reads it as absent'
	},
	{
		name: 'keeper → account_session_list via GET with ?params={} → 200',
		request: { method: 'account_session_list', as: 'keeper', params: {}, verb: 'GET' },
		expect: { status: 200 },
		note: 'the GET query path reads an empty params object as absent too'
	},
	{
		name: 'keeper → account_verify with a declared key → 400',
		request: { method: 'account_verify', as: 'keeper', params: { nope: 1 } },
		expect: { status: 400 },
		note: 'a void input still refuses any declared key with invalid_params'
	}
];
