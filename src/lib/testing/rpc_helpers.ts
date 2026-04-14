import './assert_dev_env.js';

/**
 * JSON-RPC request construction and response assertion helpers.
 *
 * Shared by `rpc_attack_surface.ts` and `rpc_round_trip.ts`.
 *
 * @module
 */

import {assert} from 'vitest';
import {z} from 'zod';

import {
	JSONRPC_VERSION,
	JsonrpcErrorResponse,
	JsonrpcResponse,
	type JsonrpcErrorCode,
} from '../http/jsonrpc.js';

/**
 * Create a `RequestInit` for a JSON-RPC POST request.
 *
 * @param method - JSON-RPC method name
 * @param params - params object (omit for null-input methods)
 * @param id - request id (default `'test'`)
 * @returns a `RequestInit` with the JSON-RPC envelope as body
 */
export const create_rpc_post_init = (
	method: string,
	params?: unknown,
	id: string | number = 'test',
): RequestInit => ({
	method: 'POST',
	headers: {'Content-Type': 'application/json'},
	body: JSON.stringify({jsonrpc: JSONRPC_VERSION, method, params, id}),
});

/**
 * Build a GET URL with JSON-RPC query parameters.
 *
 * @param endpoint_path - the RPC endpoint path (e.g., `/api/rpc`)
 * @param method - JSON-RPC method name
 * @param params - params object (omit for null-input methods)
 * @param id - request id (default `'test'`)
 * @returns the full URL with query string
 */
export const create_rpc_get_url = (
	endpoint_path: string,
	method: string,
	params?: unknown,
	id: string | number = 'test',
): string => {
	const search = new URLSearchParams({method, id: String(id)});
	if (params !== undefined && params !== null) {
		search.set('params', JSON.stringify(params));
	}
	return `${endpoint_path}?${search.toString()}`;
};

/**
 * Assert that a response body is a valid JSON-RPC error response.
 *
 * Validates the structure matches `JsonrpcErrorResponse` and optionally
 * checks the error code.
 *
 * @param body - parsed response body
 * @param expected_code - optional error code to assert
 */
export const assert_jsonrpc_error_response = (
	body: unknown,
	expected_code?: JsonrpcErrorCode,
): void => {
	const result = JsonrpcErrorResponse.safeParse(body);
	assert.ok(result.success, `not a valid JSON-RPC error response: ${JSON.stringify(body)}`);
	if (expected_code !== undefined) {
		assert.strictEqual(
			result.data.error.code,
			expected_code as number,
			`expected error code ${expected_code}, got ${result.data.error.code}`,
		);
	}
};

/**
 * Assert that a response body is a valid JSON-RPC success response.
 *
 * Validates the structure matches `JsonrpcResponse`. When `output_schema`
 * is provided, also validates the `result` field against the declared
 * output schema — matching the REST round-trip's `assert_response_matches_spec`.
 *
 * @param body - parsed response body
 * @param output_schema - optional Zod schema to validate the `result` field against
 */
export const assert_jsonrpc_success_response = (body: unknown, output_schema?: z.ZodType): void => {
	const result = JsonrpcResponse.safeParse(body);
	assert.ok(result.success, `not a valid JSON-RPC success response: ${JSON.stringify(body)}`);
	if (output_schema) {
		const output_result = output_schema.safeParse(result.data.result);
		assert.ok(
			output_result.success,
			`JSON-RPC result does not match output schema: ${JSON.stringify((output_result as any).error?.issues)}`,
		);
	}
};
