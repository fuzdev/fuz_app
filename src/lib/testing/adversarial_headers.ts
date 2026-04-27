import './assert_dev_env.js';

/**
 * Adversarial header attack test suite.
 *
 * Provides standard header injection test cases and a convenience wrapper
 * for exercising middleware stacks with adversarial headers.
 *
 * @module
 */

import {test, assert, describe} from 'vitest';
import type {z} from 'zod';

import {ApiError, ERROR_FORBIDDEN_ORIGIN, ERROR_FORBIDDEN_REFERER} from '../http/error_schemas.js';
import {
	create_test_middleware_stack_app,
	TEST_MIDDLEWARE_PATH,
	type TestMiddlewareStackOptions,
} from './middleware.js';

// --- Adversarial header attack types and runner ---

/** A header-level attack case for middleware stack testing. */
export interface AdversarialHeaderCase {
	name: string;
	headers: Record<string, string>;
	expected_status: number;
	expected_error?: string;
	/** Zod schema to validate error response body against. Defaults to `ApiError` when `expected_error` is set. */
	expected_error_schema?: z.ZodType;
	/** Whether the request should reach token validation or be short-circuited by earlier middleware. */
	validate_expectation: 'called' | 'not_called';
}

// --- Standard adversarial header cases ---

/**
 * 7 standard adversarial header cases applicable to any middleware stack.
 *
 * @param allowed_origin - an origin that passes the origin check
 * @returns the standard adversarial header cases
 */
export const create_standard_adversarial_cases = (
	allowed_origin: string,
): Array<AdversarialHeaderCase> => [
	{
		name: 'bearer token with Origin header is rejected before token validation',
		headers: {
			Authorization: 'Bearer secret_fuz_token_test',
			Origin: 'https://attacker.com',
		},
		expected_status: 403,
		expected_error: ERROR_FORBIDDEN_ORIGIN,
		validate_expectation: 'not_called',
	},
	{
		name: 'bearer token with allowed Origin — bearer silently discarded (browser context)',
		headers: {
			Authorization: 'Bearer secret_fuz_token_test',
			Origin: allowed_origin,
		},
		expected_status: 200,
		validate_expectation: 'not_called',
	},
	{
		name: 'request with no auth headers passes through all middleware',
		headers: {},
		expected_status: 200,
		validate_expectation: 'not_called',
	},
	{
		name: 'empty Origin header is rejected by origin middleware before bearer auth (defense-in-depth)',
		headers: {
			Authorization: 'Bearer secret_fuz_token_test',
			Origin: '',
		},
		expected_status: 403,
		expected_error: ERROR_FORBIDDEN_ORIGIN,
		validate_expectation: 'not_called',
	},
	{
		name: 'lowercase bearer scheme is recognized (case-insensitive per RFC 7235), soft-fails',
		headers: {
			Authorization: 'bearer secret_fuz_token_test',
		},
		expected_status: 200,
		validate_expectation: 'called',
	},
	{
		name: 'bearer token with Referer from untrusted source is rejected',
		headers: {
			Authorization: 'Bearer secret_fuz_token_test',
			Referer: 'https://attacker.com/page',
		},
		expected_status: 403,
		expected_error: ERROR_FORBIDDEN_REFERER,
		validate_expectation: 'not_called',
	},
	{
		name: 'bearer token with Referer from allowed origin — bearer silently discarded (browser context)',
		headers: {
			Authorization: 'Bearer secret_fuz_token_test',
			Referer: `${allowed_origin}/page`,
		},
		expected_status: 200,
		validate_expectation: 'not_called',
	},
];

// --- Convenience wrapper ---

/**
 * Create a middleware stack app with standard adversarial header tests.
 *
 * Convenience wrapper combining `create_test_middleware_stack_app`
 * and `create_standard_adversarial_cases`. Generates one `test()` per case
 * inside a `describe()` block — asserts body content for both error and
 * success cases, and verifies that `mock_validate` was (or was not) reached
 * per the case's `validate_expectation` flag, ensuring earlier middleware
 * actually short-circuits before token validation in the rejection cases.
 *
 * @param suite_name - the describe block name
 * @param options - middleware stack configuration
 * @param allowed_origin - an origin that passes the origin check (used for standard cases)
 * @param extra_cases - additional cases appended after the 7 standard ones
 */
export const describe_standard_adversarial_headers = (
	suite_name: string,
	options: TestMiddlewareStackOptions,
	allowed_origin: string,
	extra_cases?: Array<AdversarialHeaderCase>,
): void => {
	const cases = [...create_standard_adversarial_cases(allowed_origin), ...(extra_cases ?? [])];

	describe(suite_name, () => {
		for (const tc of cases) {
			test(tc.name, async () => {
				const {app, mock_validate} = create_test_middleware_stack_app(options);
				const res = await app.request(TEST_MIDDLEWARE_PATH, {headers: tc.headers});
				assert.strictEqual(res.status, tc.expected_status);
				const body = await res.json();
				if (tc.expected_error) {
					assert.strictEqual(body.error, tc.expected_error);
					const error_schema = tc.expected_error_schema ?? ApiError;
					error_schema.parse(body);
				}
				if (tc.expected_status === 200) {
					assert.strictEqual(body.ok, true, 'expected ok to be true for 200 response');
					assert.strictEqual(body.has_context, false, 'expected has_context to be false (no auth)');
				}
				if (tc.validate_expectation === 'not_called') {
					assert.strictEqual(
						mock_validate.mock.calls.length,
						0,
						'validate should not have been called — middleware should short-circuit',
					);
				} else {
					assert.ok(
						mock_validate.mock.calls.length > 0,
						'validate should have been called — request reached token validation',
					);
				}
			});
		}
	});
};
