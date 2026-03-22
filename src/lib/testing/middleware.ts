import './assert_dev_env.js';

/**
 * Table-driven middleware test helpers.
 *
 * Provides mock builders for bearer auth middleware dependencies,
 * a generic test runner that iterates case tables, and a reusable
 * middleware stack factory for integration testing.
 *
 * @module
 */

import {vi, test, assert, describe} from 'vitest';
import {Hono} from 'hono';
import type {z} from 'zod';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {create_bearer_auth_middleware} from '../auth/bearer_auth.js';
import {query_validate_api_token} from '../auth/api_token_queries.js';
import {query_account_by_id, query_actor_by_account} from '../auth/account_queries.js';
import {query_permit_find_active_for_actor} from '../auth/permit_queries.js';
import type {QueryDeps} from '../db/query_deps.js';
import {create_proxy_middleware, get_client_ip} from '../http/proxy.js';
import {verify_request_source, parse_allowed_origins} from '../http/origin.js';
import type {RateLimiter} from '../rate_limiter.js';
import {REQUEST_CONTEXT_KEY, type RequestContext} from '../auth/request_context.js';
import {CREDENTIAL_TYPE_KEY} from '../hono_context.js';
import {ApiError} from '../http/error_schemas.js';

// Mock the query modules so test cases can control return values.
// vi.mock() is hoisted by vitest, so these run before any imports resolve.
vi.mock('../auth/api_token_queries.js', () => ({
	query_validate_api_token: vi.fn(),
}));

vi.mock('../auth/account_queries.js', () => ({
	query_account_by_id: vi.fn(),
	query_actor_by_account: vi.fn(),
}));

vi.mock('../auth/permit_queries.js', () => ({
	query_permit_find_active_for_actor: vi.fn(),
}));

// --- Types ---

/** Mock configuration for bearer auth middleware test setup. */
export interface BearerAuthTestOptions {
	/** Test description. */
	name: string;
	/** Request headers. */
	headers?: Record<string, string>;
	/** Pre-set request context (simulates session already resolved). */
	pre_context?: RequestContext;
	/** What `query_validate_api_token()` returns. */
	mock_validate_result?: unknown;
	/** What `query_account_by_id()` returns. */
	mock_find_by_id_result?: unknown;
	/** What `query_actor_by_account()` returns. */
	mock_find_by_account_result?: unknown;
	/** What `query_permit_find_active_for_actor()` returns. */
	mock_permits_result?: unknown;
	/** Expected HTTP status, or `'next'` if the middleware should call `next()`. */
	expected_status: number | 'next';
	/** Expected `error` field in JSON response body. */
	expected_error?: string;
	/** Zod schema to validate error response body against. Defaults to `ApiError` when `expected_error` is set. */
	expected_error_schema?: z.ZodType;
}

/** A full test case for the table-driven bearer auth runner. */
export interface BearerAuthTestCase extends BearerAuthTestOptions {
	/** Whether the request should reach token validation or be short-circuited. */
	validate_expectation: 'called' | 'not_called';
	/** If true, assert `REQUEST_CONTEXT_KEY` and `CREDENTIAL_TYPE_KEY` were set to api_token values. */
	assert_context_set?: boolean;
	/** If true, assert the pre-existing session context and credential type are preserved. */
	assert_context_preserved?: boolean;
	/** Optional callback for custom spy assertions on the mocks bundle. */
	assert_mocks?: (mocks: BearerAuthMocks) => void;
}

// --- Mock builders ---

/** Mocks bundle returned by `create_bearer_auth_mocks`. */
export interface BearerAuthMocks {
	mock_validate: ReturnType<typeof vi.fn>;
	mock_find_by_id: ReturnType<typeof vi.fn>;
	mock_find_by_account: ReturnType<typeof vi.fn>;
	mock_find_active_for_actor: ReturnType<typeof vi.fn>;
}

/** Stub `QueryDeps` for bearer auth tests (no real DB needed). */
const STUB_DEPS: QueryDeps = {db: {} as any};

/**
 * Create mock dependencies for `create_bearer_auth_middleware`, configured per test case.
 *
 * Configures the module-level mocks for `query_validate_api_token`,
 * `query_account_by_id`, `query_actor_by_account`, and `query_permit_find_active_for_actor`
 * so each test case controls return values independently.
 *
 * @param tc - the test config providing mock return values
 * @returns mocks bundle with spy references
 */
export const create_bearer_auth_mocks = (tc: BearerAuthTestOptions): BearerAuthMocks => {
	const mock_validate = vi.mocked(query_validate_api_token);
	const mock_find_by_id = vi.mocked(query_account_by_id);
	const mock_find_by_account = vi.mocked(query_actor_by_account);
	const mock_find_active_for_actor = vi.mocked(query_permit_find_active_for_actor);

	mock_validate
		.mockReset()
		.mockImplementation(() => Promise.resolve(tc.mock_validate_result) as any);
	mock_find_by_id
		.mockReset()
		.mockImplementation(() => Promise.resolve(tc.mock_find_by_id_result) as any);
	mock_find_by_account
		.mockReset()
		.mockImplementation(() => Promise.resolve(tc.mock_find_by_account_result) as any);
	mock_find_active_for_actor
		.mockReset()
		.mockImplementation(() => Promise.resolve(tc.mock_permits_result ?? []) as any);

	return {mock_validate, mock_find_by_id, mock_find_by_account, mock_find_active_for_actor};
};

/** Default client IP set by the proxy stub in test apps. */
export const TEST_CLIENT_IP = '127.0.0.1';

/**
 * Create a Hono app wired with `create_bearer_auth_middleware` using mocked deps.
 *
 * The route handler at `/api/test` returns the resolved context in the response body,
 * enabling assertions on `REQUEST_CONTEXT_KEY` and `CREDENTIAL_TYPE_KEY`.
 *
 * @param tc - the test config providing mock behavior
 * @param ip_rate_limiter - optional rate limiter (null to disable)
 * @returns the app and mocks bundle
 */
export const create_bearer_auth_test_app = (
	tc: BearerAuthTestOptions,
	ip_rate_limiter: RateLimiter | null = null,
): {app: Hono; mocks: BearerAuthMocks} => {
	const mocks = create_bearer_auth_mocks(tc);

	const bearer_middleware = create_bearer_auth_middleware(
		STUB_DEPS,
		ip_rate_limiter,
		new Logger('test', {level: 'off'}),
	);

	const app = new Hono();

	// inject pre-existing request context if the test case specifies one
	if (tc.pre_context) {
		app.use('*', async (c, next) => {
			c.set(REQUEST_CONTEXT_KEY, tc.pre_context!);
			c.set(CREDENTIAL_TYPE_KEY, 'session');
			await next();
		});
	}

	// proxy middleware stub — sets a known client_ip
	app.use('*', async (c, next) => {
		c.set('client_ip', TEST_CLIENT_IP);
		await next();
	});

	app.use('/api/*', bearer_middleware);

	// route handler echoes full context state for assertions
	app.get('/api/test', (c) => {
		const ctx = c.get(REQUEST_CONTEXT_KEY);
		const cred = c.get(CREDENTIAL_TYPE_KEY);
		return c.json({
			ok: true,
			has_context: ctx != null,
			credential_type: cred ?? null,
			account_id: ctx?.account.id ?? null,
			actor_id: ctx?.actor.id ?? null,
			permit_count: ctx?.permits.length ?? 0,
		});
	});

	return {app, mocks};
};

// --- Table-driven test runner ---

/**
 * Run a table of bearer auth middleware test cases.
 *
 * Generates one `test()` per case inside a `describe()` block.
 *
 * @param suite_name - the describe block name
 * @param cases - the test case table
 * @param ip_rate_limiter - optional rate limiter shared across cases
 */
export const describe_bearer_auth_cases = (
	suite_name: string,
	cases: Array<BearerAuthTestCase>,
	ip_rate_limiter: RateLimiter | null = null,
): void => {
	describe(suite_name, () => {
		for (const tc of cases) {
			test(tc.name, async () => {
				const {app, mocks} = create_bearer_auth_test_app(tc, ip_rate_limiter);

				const res = await app.request('/api/test', {
					method: 'GET',
					headers: tc.headers,
				});

				const body = await res.json();

				if (tc.expected_status === 'next') {
					assert.strictEqual(res.status, 200, `expected next() but got ${res.status}`);
				} else {
					assert.strictEqual(res.status, tc.expected_status);
					if (tc.expected_error) {
						assert.strictEqual(body.error, tc.expected_error);
						const error_schema = tc.expected_error_schema ?? ApiError;
						error_schema.parse(body);
					}
				}

				if (tc.validate_expectation === 'not_called') {
					assert.strictEqual(
						mocks.mock_validate.mock.calls.length,
						0,
						'validate should not have been called',
					);
				} else {
					assert.ok(mocks.mock_validate.mock.calls.length > 0, 'validate should have been called');
				}

				if (tc.assert_context_set) {
					assert.strictEqual(body.has_context, true, 'REQUEST_CONTEXT_KEY should be set');
					assert.strictEqual(
						body.credential_type,
						'api_token',
						'CREDENTIAL_TYPE_KEY should be api_token',
					);
				}

				if (tc.assert_context_preserved) {
					assert.strictEqual(body.has_context, true, 'original context should be preserved');
					assert.strictEqual(
						body.credential_type,
						'session',
						'credential type should remain session',
					);
				}

				if (tc.assert_mocks) {
					tc.assert_mocks(mocks);
				}
			});
		}
	});
};

// --- Middleware stack test factory ---

/** Path used by the echo route in `create_test_middleware_stack_app`. */
export const TEST_MIDDLEWARE_PATH = '/api/test';

/** Options for `create_test_middleware_stack_app`. */
export interface TestMiddlewareStackOptions {
	/** Trusted proxy IPs. @default `['10.0.0.1']` */
	trusted_proxies?: Array<string>;
	/** Comma-separated allowed origin patterns. @default `'https://app.example.com'` */
	allowed_origins?: string;
	/** Connection IP or factory. @default first trusted proxy */
	connection_ip?: string | (() => string | undefined);
	/** Rate limiter for bearer auth. @default `null` */
	ip_rate_limiter?: RateLimiter | null;
}

/** Return type of `create_test_middleware_stack_app`. */
export interface TestMiddlewareStackApp {
	app: Hono;
	mock_validate: ReturnType<typeof vi.fn>;
	mock_find_by_id: ReturnType<typeof vi.fn>;
	mock_find_by_account: ReturnType<typeof vi.fn>;
	mock_find_active_for_actor: ReturnType<typeof vi.fn>;
}

/**
 * Create a Hono app with real proxy + origin + bearer middleware for integration testing.
 *
 * All DB queries return undefined (no real database needed).
 * The echo route at `TEST_MIDDLEWARE_PATH` returns `{ok, client_ip, has_context}`.
 *
 * @param options - middleware stack configuration
 * @returns the app and mock spies (reconfigure via `mockImplementation` for valid-token paths)
 */
export const create_test_middleware_stack_app = (
	options?: TestMiddlewareStackOptions,
): TestMiddlewareStackApp => {
	const trusted_proxies = options?.trusted_proxies ?? ['10.0.0.1'];
	const allowed_origins_str = options?.allowed_origins ?? 'https://app.example.com';

	const mock_validate = vi.mocked(query_validate_api_token);
	const mock_find_by_id = vi.mocked(query_account_by_id);
	const mock_find_by_account = vi.mocked(query_actor_by_account);
	const mock_find_active_for_actor = vi.mocked(query_permit_find_active_for_actor);

	mock_validate.mockReset().mockImplementation(() => Promise.resolve(undefined) as any);
	mock_find_by_id.mockReset().mockImplementation(() => Promise.resolve(undefined) as any);
	mock_find_by_account.mockReset().mockImplementation(() => Promise.resolve(undefined) as any);
	mock_find_active_for_actor.mockReset().mockImplementation(() => Promise.resolve([]) as any);

	const get_connection_ip =
		typeof options?.connection_ip === 'function'
			? options.connection_ip
			: () => options?.connection_ip ?? trusted_proxies[0];

	const proxy_mw = create_proxy_middleware({
		trusted_proxies,
		get_connection_ip: get_connection_ip as any,
	});

	const allowed_patterns = parse_allowed_origins(allowed_origins_str);
	const origin_mw = verify_request_source(allowed_patterns);

	const bearer_mw = create_bearer_auth_middleware(
		STUB_DEPS,
		options?.ip_rate_limiter ?? null,
		new Logger('test', {level: 'off'}),
	);

	const app = new Hono();
	app.use('*', proxy_mw);
	app.use('/api/*', origin_mw);
	app.use('/api/*', bearer_mw);

	// echo route for assertions
	app.get(TEST_MIDDLEWARE_PATH, (c) => {
		const ctx = c.get(REQUEST_CONTEXT_KEY);
		return c.json({
			ok: true,
			client_ip: get_client_ip(c),
			has_context: ctx != null,
		});
	});

	return {app, mock_validate, mock_find_by_id, mock_find_by_account, mock_find_active_for_actor};
};
