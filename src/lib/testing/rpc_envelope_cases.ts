import './assert_dev_env.ts';

/**
 * The malformed-envelope and invalid-params cases for a JSON-RPC endpoint, as
 * data.
 *
 * Hono-free, so the in-process `describe_rpc_attack_surface_tests` and the
 * cross-process `describe_rpc_adversarial_cross_tests` run one set: the
 * envelope cases (`create_rpc_envelope_cases`) and the per-method params
 * cases (`generate_rpc_params_test_cases`).
 *
 * @module
 */

import { assert } from 'vitest';
import type { z } from 'zod';

import type { AppSurfaceRpcEndpoint, AppSurfaceRpcMethod } from '../http/surface.ts';
import { is_public_auth } from '../http/auth_shape.ts';
import { JSONRPC_ERROR_CODES } from '../http/jsonrpc_errors.ts';
import type { JsonrpcErrorCode, JsonrpcRequestId } from '../http/jsonrpc.ts';
import { ERROR_AUTHENTICATION_REQUIRED, ERROR_INVALID_JSON_BODY } from '../http/error_schemas.ts';
import { PROTOCOL_ACTION_METHODS } from '../actions/action_codegen.ts';
import { TESTING_METHOD_PREFIX } from './surface_invariants.ts';
import { assert_jsonrpc_error_response } from './rpc_helpers.ts';
import {
	generate_input_test_cases,
	type InputTestCase,
	type InputTestCaseOptions
} from './adversarial_input_cases.ts';

const PROTOCOL_METHODS: ReadonlySet<string> = new Set(PROTOCOL_ACTION_METHODS);

/** The request id every envelope case sends where it sends one. */
export const RPC_ENVELOPE_PROBE_ID = 'envelope_probe';

/**
 * One malformed-envelope request and the refusal it owes.
 *
 * Data, so the in-process group here and the cross-process
 * `describe_rpc_adversarial_cross_tests` run the same set.
 */
export interface RpcEnvelopeCase {
	readonly name: string;
	/**
	 * Who sends it: the principal `method`'s auth admits, so the envelope check
	 * is what refuses, or no credential at all — the ordering cases, where an
	 * answer of 401 would mean auth ran before the envelope check.
	 */
	readonly as: 'authorized' | 'anonymous';
	/** The declared method whose auth picks the principal (`'authorized'`). */
	readonly method: AppSurfaceRpcMethod;
	/** A raw POST body, or a GET query string starting with `?`. */
	readonly request:
		| { readonly verb: 'POST'; readonly body: string }
		| { readonly verb: 'GET'; readonly query: string };
	readonly expect: {
		readonly status: number;
		readonly code: JsonrpcErrorCode;
		/** The echoed `id` — `null` where the request carries none the server can read. */
		readonly id: JsonrpcRequestId | null;
		/** `error.data.reason` exactly, or `null` to require it absent. */
		readonly reason: string | null;
	};
}

/** Options for `create_rpc_envelope_cases`. */
export interface RpcEnvelopeCaseOptions {
	/** Method names never chosen as a case's method. */
	readonly skip_methods?: ReadonlyArray<string>;
}

/**
 * The JSON values that are neither an object nor `null`, one per JSON type —
 * what a `GET` `?params=` can carry that no input schema admits.
 */
export const RPC_NON_OBJECT_PARAMS: ReadonlyArray<string> = ['42', '[1]', '"x"', 'true'];

/** The `data.reason` the dispatchers answer a `GET` of a `side_effects` method with. */
export const rpc_get_side_effects_reason = (method: string): string =>
	`method '${method}' has side effects and must use POST`;

/**
 * Build the malformed-envelope cases for one RPC endpoint — the dispatcher's
 * envelope parse, method lookup, and GET read restriction.
 *
 * The POST cases and the GET read cases ride the endpoint's first read method
 * (`side_effects: false`), the GET mutation cases its first mutation that
 * needs an account. `_testing_*` and protocol methods are never chosen. A case
 * whose method the endpoint lacks is left out.
 *
 * Every read (`side_effects: false`) gets a `GET` with each of
 * `RPC_NON_OBJECT_PARAMS` → `invalid_params`: the query string is no envelope,
 * so the dispatcher's params validation is what refuses it.
 *
 * Three cases pin an order against auth, sent with no credential: a `GET` of
 * a mutating method is refused `invalid_request` (the read restriction runs
 * after the method lookup and before authorization), a batch array is
 * refused `invalid_request` with `id: null` (the envelope parse runs first,
 * and batches are unsupported), and a `GET` with non-object params on a
 * read requiring an identity is the 401 (params validation runs after authorization).
 *
 * @param endpoint - the endpoint from the generated surface
 * @param options - methods never chosen
 * @returns the cases, in a fixed order
 */
export const create_rpc_envelope_cases = (
	endpoint: AppSurfaceRpcEndpoint,
	options: RpcEnvelopeCaseOptions = {}
): Array<RpcEnvelopeCase> => {
	const skip = new Set(options.skip_methods);
	const eligible = endpoint.methods.filter(
		(m) =>
			!m.name.startsWith(TESTING_METHOD_PREFIX) &&
			!PROTOCOL_METHODS.has(m.name) &&
			!skip.has(m.name)
	);
	const read = eligible.find((m) => !m.side_effects);
	const mutation = eligible.find((m) => m.side_effects && !is_public_auth(m.auth));
	const id = RPC_ENVELOPE_PROBE_ID;
	const cases: Array<RpcEnvelopeCase> = [];

	if (read) {
		const post = (name: string, body: string, expect: RpcEnvelopeCase['expect']): void => {
			cases.push({ name, as: 'authorized', method: read, request: { verb: 'POST', body }, expect });
		};
		const get = (name: string, query: string, expect: RpcEnvelopeCase['expect']): void => {
			cases.push({ name, as: 'authorized', method: read, request: { verb: 'GET', query }, expect });
		};
		const invalid_request = { status: 400, code: JSONRPC_ERROR_CODES.invalid_request };
		const m = read.name;
		const q = encodeURIComponent;

		post('non-JSON body → parse_error', 'not-json', {
			status: 400,
			code: JSONRPC_ERROR_CODES.parse_error,
			id: null,
			reason: null
		});
		post(
			'wrong jsonrpc version → invalid_request',
			JSON.stringify({ jsonrpc: '1.0', id, method: m }),
			{ ...invalid_request, id, reason: null }
		);
		post('missing jsonrpc field → invalid_request', JSON.stringify({ id, method: m }), {
			...invalid_request,
			id,
			reason: null
		});
		post('missing method field → invalid_request', JSON.stringify({ jsonrpc: '2.0', id }), {
			...invalid_request,
			id,
			reason: null
		});
		post('missing id field → invalid_request', JSON.stringify({ jsonrpc: '2.0', method: m }), {
			...invalid_request,
			id: null,
			reason: null
		});
		// HTTP issues no server-initiated requests, so a reply is refused like a
		// notification, its id unechoed
		post(
			'response-shaped body → invalid_request',
			JSON.stringify({ jsonrpc: '2.0', id, result: {} }),
			{ ...invalid_request, id: null, reason: null }
		);
		post(
			'batch (array) body → invalid_request',
			JSON.stringify([{ jsonrpc: '2.0', id, method: m }]),
			{ ...invalid_request, id: null, reason: null }
		);
		post(
			'unknown method name → method_not_found',
			JSON.stringify({ jsonrpc: '2.0', id, method: '__nonexistent_method__' }),
			{ status: 404, code: JSONRPC_ERROR_CODES.method_not_found, id, reason: null }
		);
		get('GET missing method → invalid_request', `?id=${id}`, {
			...invalid_request,
			id: null,
			reason: 'missing method query parameter'
		});
		get('GET missing id → invalid_request', `?method=${q(m)}`, {
			...invalid_request,
			id: null,
			reason: 'missing id query parameter'
		});
		get('GET invalid JSON params → invalid_params', `?method=${q(m)}&id=${id}&params=not-json`, {
			status: 400,
			code: JSONRPC_ERROR_CODES.invalid_params,
			id,
			reason: null
		});
		// a present non-object `params` fails the envelope schema on POST
		post(
			'POST non-object params → invalid_request',
			JSON.stringify({ jsonrpc: '2.0', id, method: m, params: 42 }),
			{ ...invalid_request, id, reason: null }
		);
	}

	// The GET query string is no envelope, so a non-object `params` reaches the
	// dispatcher's params validation — on every read, since a spine that decodes
	// params per handler can drift on any of them.
	for (const r of eligible) {
		if (r.side_effects) continue;
		for (const value of RPC_NON_OBJECT_PARAMS) {
			cases.push({
				name: `GET non-object params (${value}) → invalid_params: ${r.name}`,
				as: 'authorized',
				method: r,
				request: {
					verb: 'GET',
					query: `?method=${encodeURIComponent(r.name)}&id=${id}&params=${encodeURIComponent(value)}`
				},
				expect: { status: 400, code: JSONRPC_ERROR_CODES.invalid_params, id, reason: null }
			});
		}
	}

	// params validation runs after authorization: an anonymous non-object
	// `params` hears the 401 of any anonymous call, not a 400 about its input.
	// The read must require an identity — an identity-optional one admits the
	// anonymous caller, whose params validation then refuses
	const protected_read = eligible.find(
		(r) => !r.side_effects && (r.auth.account === 'required' || r.auth.actor === 'required')
	);
	if (protected_read) {
		cases.push({
			name: 'ordering: anonymous GET non-object params → 401, not invalid_params',
			as: 'anonymous',
			method: protected_read,
			request: {
				verb: 'GET',
				query: `?method=${encodeURIComponent(protected_read.name)}&id=${id}&params=42`
			},
			expect: {
				status: 401,
				code: JSONRPC_ERROR_CODES.unauthenticated,
				id,
				reason: ERROR_AUTHENTICATION_REQUIRED
			}
		});
	}

	if (mutation) {
		const query = `?method=${encodeURIComponent(mutation.name)}&id=${id}`;
		const expect = {
			status: 400,
			code: JSONRPC_ERROR_CODES.invalid_request,
			id,
			reason: rpc_get_side_effects_reason(mutation.name)
		};
		cases.push({
			name: 'GET mutation method → invalid_request (side effects)',
			as: 'authorized',
			method: mutation,
			request: { verb: 'GET', query },
			expect
		});
		cases.push({
			name: 'ordering: anonymous GET mutation method → invalid_request, not 401',
			as: 'anonymous',
			method: mutation,
			request: { verb: 'GET', query },
			expect
		});
		cases.push({
			name: 'ordering: anonymous batch (array) body → invalid_request, not 401',
			as: 'anonymous',
			method: mutation,
			request: {
				verb: 'POST',
				body: JSON.stringify([{ jsonrpc: '2.0', id, method: mutation.name }])
			},
			expect: { status: 400, code: JSONRPC_ERROR_CODES.invalid_request, id: null, reason: null }
		});
	}

	return cases;
};

/**
 * Build the `RequestInit` + path suffix for an envelope case.
 *
 * @param endpoint_path - the RPC endpoint path
 * @param c - the case
 * @param headers - auth headers to merge in
 * @returns the URL (path + query for GET) and the init
 */
export const to_rpc_envelope_request = (
	endpoint_path: string,
	c: RpcEnvelopeCase,
	headers: Record<string, string> = {}
): { url: string; init: RequestInit } =>
	c.request.verb === 'POST'
		? {
				url: endpoint_path,
				init: {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', ...headers },
					body: c.request.body
				}
			}
		: { url: `${endpoint_path}${c.request.query}`, init: { method: 'GET', headers } };

/**
 * Assert a response body is the refusal an envelope case owes: a well-formed
 * JSON-RPC error envelope with the case's code, echoed id, and `data.reason`.
 *
 * @param status - the response's HTTP status
 * @param body - the parsed response body
 * @param c - the case
 */
export const assert_rpc_envelope_refusal = (
	status: number,
	body: unknown,
	c: RpcEnvelopeCase
): void => {
	const detail = `${c.name}: got ${status} ${JSON.stringify(body)}`;
	assert.strictEqual(status, c.expect.status, detail);
	assert_jsonrpc_error_response(body, c.expect.code);
	const envelope = body as { id: unknown; error: { data?: unknown } };
	assert.strictEqual(envelope.id, c.expect.id, `${detail} — echoed id`);
	const data = envelope.error.data;
	const reason =
		typeof data === 'object' && data !== null ? (data as { reason?: unknown }).reason : undefined;
	assert.strictEqual(reason ?? null, c.expect.reason, `${detail} — data.reason`);
};

/**
 * Generate the schema-invalid params cases for one RPC method's input.
 *
 * `generate_input_test_cases` minus its structural cases: a non-object body
 * is a non-object `params`, which the JSON-RPC envelope refuses
 * (`invalid_request`) before params validation runs, and the envelope cases
 * cover it. Every case returned owes 400 `invalid_params`.
 *
 * @param input - the method's input schema
 * @param options - a valid base `params` to seed the cases (`InputTestCaseOptions.base`),
 *   and the method name for error messages
 * @returns the cases, each a `params` object
 * @throws Error if the base `params`, seeded or generated, fails the input schema
 */
export const generate_rpc_params_test_cases = (
	input: z.ZodType,
	options?: InputTestCaseOptions
): Array<InputTestCase> =>
	generate_input_test_cases(input, options).filter(
		(tc) => tc.expected_error !== ERROR_INVALID_JSON_BODY
	);
