import { assert, describe, test } from 'vitest';

import {
	check_conformance_cases,
	describe_conformance_table_tests
} from '#lib/testing/cross_backend/conformance_table.ts';
import type { ConformanceCase } from '#lib/testing/cross_backend/conformance_case.ts';
import { in_process_capabilities } from '#lib/testing/cross_backend/capabilities.ts';
import { JSONRPC_ERROR_CODES } from '#lib/http/jsonrpc_errors.ts';
import type { AppSurfaceSpec } from '#lib/http/surface.ts';

const REST_NULL_MESSAGE =
	"conformance: case 'a REST row' pins error_reason null on a REST route, whose error body " +
	'always names its code in `error` — pin the code instead.';

const rest_null: ConformanceCase = {
	name: 'a REST row',
	request: { method: '/logout', as: 'anonymous' },
	expect: { status: 401, error_reason: null }
};

const minting_refusal = (set_cookie: 'set' | 'clear_then_set'): ConformanceCase => ({
	name: 'a minting refusal',
	request: { method: '/login', as: 'anonymous' },
	expect: { status: 401, set_cookie }
});

/** Register a table over `cases` with options that never reach a backend. */
const register = (cases: ReadonlyArray<ConformanceCase>): void =>
	describe_conformance_table_tests({
		cases,
		setup_test: () => Promise.reject(new Error('no backend')),
		surface_source: {} as AppSurfaceSpec,
		capabilities: in_process_capabilities,
		rpc_endpoints: [],
		session_cookie_name: 'fuz_session'
	});

describe('check_conformance_cases', () => {
	test('refuses error_reason null on a REST row, naming it', () => {
		assert.throws(() => check_conformance_cases([rest_null]), REST_NULL_MESSAGE);
	});

	test('admits error_reason null on an RPC row', () => {
		check_conformance_cases([
			{ ...rest_null, request: { method: 'account_verify', as: 'anonymous' } }
		]);
	});

	test('refuses error_code on a REST row', () => {
		assert.throws(
			() =>
				check_conformance_cases([
					{
						...rest_null,
						expect: { status: 400, error_code: JSONRPC_ERROR_CODES.invalid_request }
					}
				]),
			/sets error_code on a REST route/
		);
	});

	test('refuses a refusal expecting a mint', () => {
		for (const effect of ['set', 'clear_then_set'] as const) {
			assert.throws(
				() => check_conformance_cases([minting_refusal(effect)]),
				/expects a 401 that mints the session cookie/,
				effect
			);
		}
	});

	test('admits a refusal that clears, and a success that mints', () => {
		check_conformance_cases([
			{ ...minting_refusal('set'), expect: { status: 401, set_cookie: 'clear' } },
			{ ...minting_refusal('set'), expect: { status: 200, set_cookie: 'clear_then_set' } }
		]);
	});
});

describe('describe_conformance_table_tests refuses at collection', () => {
	test('a REST row pinning error_reason null', () => {
		assert.throws(() => register([rest_null]), REST_NULL_MESSAGE);
	});

	test('a refusal expecting a mint', () => {
		assert.throws(
			() => register([minting_refusal('set')]),
			/expects a 401 that mints the session cookie/
		);
	});
});
