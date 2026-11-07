/**
 * Conformance cases for U+0000 in `params`.
 *
 * `"\u0000"` is valid JSON that Postgres refuses in `text` and `jsonb`, so a
 * call that stored it would answer 500. Both spines walk object params once
 * (`scan_json_value`, `fuz_http::scan_json_value`) and refuse a NUL in any
 * string or key with `invalid_params` and `data.reason` `params_nul`, before
 * the input schema runs and after the authority gates, on every transport —
 * the POST cases run over the WebSocket leg too. An own `__proto__` key in the
 * same params answers first. The walk reads the parsed value, so of two
 * duplicate keys only the kept (last) one counts, on both spines. A REST
 * route body holding one is 400 `invalid_request_body`, ahead of its schema
 * and handler (`create_input_validation`, `fuz_http::parse_json_body`); the
 * REST rows put the NUL in a field nothing else refuses, so the control —
 * the same body without it — is each route's later answer.
 *
 * @module
 */

import {
	ERROR_INVALID_REQUEST_BODY,
	ERROR_PARAMS_NUL,
	ERROR_PARAMS_PROTO_KEY
} from '#lib/http/error_schemas.ts';
import { DEFAULT_TEST_PASSWORD } from '#lib/testing/test_credentials.ts';
import type { ConformanceCase } from '#lib/testing/cross_backend/conformance_case.ts';

const note = 'actions/perform_action.ts step 5 — the NUL walk runs before the input schema';
const rest_note =
	'http/route_spec.ts create_input_validation — the NUL walk runs before the body schema';

/** A password the schemas admit, holding U+0000. */
const NUL_PASSWORD = `${DEFAULT_TEST_PASSWORD}\u0000`;

export const conformance_nul_params_cases: ReadonlyArray<ConformanceCase> = [
	{
		name: 'keeper → account_verify with a NUL in a params string → 400 params_nul',
		request: { method: 'account_verify', as: 'keeper', params_json: '{"x":"a\\u0000b"}' },
		expect: { status: 400, error_reason: ERROR_PARAMS_NUL },
		note: `${note}; a void input is walked like any other`
	},
	{
		name: 'keeper → account_session_list via GET with a NUL in a params string → 400 params_nul',
		request: {
			method: 'account_session_list',
			as: 'keeper',
			params: { x: 'a\u0000b' },
			verb: 'GET'
		},
		expect: { status: 400, error_reason: ERROR_PARAMS_NUL },
		note: `${note}; the GET query path refuses it as the POST body does`
	},
	{
		name: 'keeper → role_grant_offer_list with a NUL in a declared field → 400 params_nul',
		request: {
			method: 'role_grant_offer_list',
			as: 'keeper',
			params_json: '{"account_id":"\\u0000"}'
		},
		expect: { status: 400, error_reason: ERROR_PARAMS_NUL },
		note: `${note}; ahead of the field's own (reasonless) refusal`
	},
	{
		name: 'keeper → role_grant_offer_list with a NUL in a key → 400 params_nul',
		request: { method: 'role_grant_offer_list', as: 'keeper', params_json: '{"\\u0000":1}' },
		expect: { status: 400, error_reason: ERROR_PARAMS_NUL },
		note: `${note}; keys too, ahead of the strict input's unknown-key refusal`
	},
	{
		name: 'keeper → role_grant_offer_list with a NUL nested under an unknown key → 400 params_nul',
		request: {
			method: 'role_grant_offer_list',
			as: 'keeper',
			params_json: '{"bogus":{"a":[1,"\\u0000"]}}'
		},
		expect: { status: 400, error_reason: ERROR_PARAMS_NUL },
		note: `${note}; at any depth`
	},
	{
		name: 'keeper → role_grant_offer_list via GET with a NUL nested under an unknown key → 400 params_nul',
		request: {
			method: 'role_grant_offer_list',
			as: 'keeper',
			params: { bogus: { a: [1, '\u0000'] } },
			verb: 'GET'
		},
		expect: { status: 400, error_reason: ERROR_PARAMS_NUL },
		note: `${note}; at any depth, on the GET query path too`
	},
	{
		name: 'keeper → role_grant_offer_list with an own __proto__ and a NUL → 400 params_proto_key',
		request: {
			method: 'role_grant_offer_list',
			as: 'keeper',
			params_json: '{"__proto__":{},"bogus":"\\u0000"}'
		},
		expect: { status: 400, error_reason: ERROR_PARAMS_PROTO_KEY },
		note: `${note}; the proto key answers first`
	},
	{
		name: 'keeper → role_grant_offer_list with a NUL under a dropped duplicate key → 200',
		request: {
			method: 'role_grant_offer_list',
			as: 'keeper',
			params_json: '{"account_id":"\\u0000","account_id":null}'
		},
		expect: { status: 200 },
		note: `${note}; the parsed value keeps the last duplicate on both spines, so only it is walked`
	},
	{
		name: 'keeper → role_grant_offer_list with a NUL under the kept duplicate key → 400 params_nul',
		request: {
			method: 'role_grant_offer_list',
			as: 'keeper',
			params_json: '{"account_id":null,"account_id":"\\u0000"}'
		},
		expect: { status: 400, error_reason: ERROR_PARAMS_NUL },
		note: `${note}; the kept duplicate is the one walked`
	},
	{
		name: 'login with a NUL in the password → 400 invalid_request_body',
		request: {
			method: '/login',
			as: 'anonymous',
			params: { username: 'keeper', password: NUL_PASSWORD }
		},
		expect: { status: 400, error_reason: ERROR_INVALID_REQUEST_BODY },
		note: `${rest_note}; without the NUL a wrong password is 401 invalid_credentials`
	},
	{
		name: 'signup with a NUL in the password → 400 invalid_request_body',
		request: {
			method: '/signup',
			as: 'anonymous',
			params: { username: 'nul_password_user', password: NUL_PASSWORD }
		},
		expect: { status: 400, error_reason: ERROR_INVALID_REQUEST_BODY },
		note: `${rest_note}; without the NUL a no-invite signup is 403 no_matching_invite`
	},
	{
		name: 'keeper → password change with a NUL in the current password → 400 invalid_request_body',
		request: {
			method: '/password',
			as: 'keeper',
			params: { current_password: NUL_PASSWORD, new_password: `${DEFAULT_TEST_PASSWORD}-next` }
		},
		expect: { status: 400, error_reason: ERROR_INVALID_REQUEST_BODY },
		note: `${rest_note}; after the session gates, ahead of the password check`
	}
];
