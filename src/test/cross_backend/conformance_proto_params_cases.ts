/**
 * Conformance cases for an own `__proto__` key in `params`.
 *
 * JSON gives `{"__proto__": …}` an ordinary own key, and both spines see it
 * as one: the dispatcher refuses params holding it at any depth with
 * `invalid_params` and `data.reason` `params_proto_key`, before the input
 * schema runs, on every transport — the POST cases run over the WebSocket leg
 * too. Nested under a key the schema would refuse, the walk still answers
 * first. The params are built with `JSON.parse`, since an object literal's
 * `__proto__` sets the prototype instead of a key. The cell rows, whose
 * methods the in-process surface does not mount, are in
 * `conformance_cell_cases`.
 *
 * @module
 */

import { ERROR_PARAMS_PROTO_KEY } from '#lib/http/error_schemas.ts';
import type { ConformanceCase } from '#lib/testing/cross_backend/conformance_case.ts';

/** `{"__proto__": {"acting": "x"}}` as an own key, the shape a client sends. */
const own_proto = (): unknown => JSON.parse('{"__proto__":{"acting":"x"}}');

/** A `__proto__` nested under a key the strict input does not declare. */
const nested_proto = (): unknown => JSON.parse('{"bogus":{"a":[{"__proto__":{}}]}}');

const note = 'actions/perform_action.ts step 5 — the proto walk runs before the input schema';

export const conformance_proto_params_cases: ReadonlyArray<ConformanceCase> = [
	{
		name: 'keeper → account_verify with an own __proto__ params key → 400 params_proto_key',
		request: { method: 'account_verify', as: 'keeper', params: own_proto() },
		expect: { status: 400, error_reason: ERROR_PARAMS_PROTO_KEY },
		note: `${note}; a void input is walked like any other`
	},
	{
		name: 'keeper → account_session_list via GET with an own __proto__ params key → 400 params_proto_key',
		request: { method: 'account_session_list', as: 'keeper', params: own_proto(), verb: 'GET' },
		expect: { status: 400, error_reason: ERROR_PARAMS_PROTO_KEY },
		note: `${note}; the GET query path refuses it as the POST body does`
	},
	{
		name: 'keeper → role_grant_offer_list with an own __proto__ params key → 400 params_proto_key',
		request: { method: 'role_grant_offer_list', as: 'keeper', params: own_proto() },
		expect: { status: 400, error_reason: ERROR_PARAMS_PROTO_KEY },
		note: `${note}; ahead of the strict input's unknown-key refusal`
	},
	{
		name: 'keeper → role_grant_offer_list via GET with an own __proto__ params key → 400 params_proto_key',
		request: { method: 'role_grant_offer_list', as: 'keeper', params: own_proto(), verb: 'GET' },
		expect: { status: 400, error_reason: ERROR_PARAMS_PROTO_KEY },
		note: `${note}; the GET query path refuses it as the POST body does`
	},
	{
		name: 'keeper → role_grant_offer_list with __proto__ nested under an unknown key → 400 params_proto_key',
		request: { method: 'role_grant_offer_list', as: 'keeper', params: nested_proto() },
		expect: { status: 400, error_reason: ERROR_PARAMS_PROTO_KEY },
		note: `${note}; at any depth, and ahead of the unknown-key refusal`
	},
	{
		name: 'keeper → role_grant_offer_list via GET with __proto__ nested under an unknown key → 400 params_proto_key',
		request: { method: 'role_grant_offer_list', as: 'keeper', params: nested_proto(), verb: 'GET' },
		expect: { status: 400, error_reason: ERROR_PARAMS_PROTO_KEY },
		note: `${note}; at any depth, on the GET query path too`
	}
];
