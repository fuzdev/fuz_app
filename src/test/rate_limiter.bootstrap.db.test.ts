/**
 * Integration tests for rate limiting through bootstrap HTTP handlers.
 *
 * Uses real in-memory PGlite so `bootstrap_account` runs fully.
 * Focuses on verifying that the bootstrap handler correctly integrates
 * with the RateLimiter.
 *
 * @module
 */

import {describe, test, assert, vi, afterEach, beforeAll} from 'vitest';
import {Hono} from 'hono';

import {RateLimiter} from '$lib/rate_limiter.js';
import {create_proxy_middleware} from '$lib/http/proxy.js';
import {create_bootstrap_route_specs} from '$lib/auth/bootstrap_routes.js';
import {apply_route_specs} from '$lib/http/route_spec.js';
import {fuz_auth_guard_resolver} from '$lib/auth/route_guards.js';
import {create_keyring} from '$lib/auth/keyring.js';
import {create_session_config} from '$lib/auth/session_cookie.js';
import {PASSWORD_LENGTH_MAX} from '$lib/auth/password.js';
import {run_migrations} from '$lib/db/migrate.js';
import {AUTH_MIGRATION_NS} from '$lib/auth/migrations.js';
import {create_pglite_factory} from '$lib/testing/db.js';
import {
	ERROR_RATE_LIMIT_EXCEEDED,
	ERROR_ALREADY_BOOTSTRAPPED,
	ERROR_BOOTSTRAP_NOT_CONFIGURED,
} from '$lib/http/error_schemas.js';
import {Logger} from '@fuzdev/fuz_util/log.js';

const log = new Logger('test', {level: 'off'});

// --- Shared fixtures ---

/** Simulated connection IP for all test requests. */
const TEST_CONNECTION_IP = '127.0.0.1';

/**
 * Proxy middleware for tests: trusts the simulated connection IP
 * so that `X-Forwarded-For` headers are honored in test requests.
 */
const test_proxy_middleware = create_proxy_middleware({
	trusted_proxies: [TEST_CONNECTION_IP],
	get_connection_ip: () => TEST_CONNECTION_IP,
});

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 3;

const create_test_limiter = (): RateLimiter =>
	new RateLimiter({max_attempts: MAX_ATTEMPTS, window_ms: WINDOW_MS, cleanup_interval_ms: 0});

const keyring = create_keyring('integration_test_key_a')!;
const session_options = create_session_config('test_session');

// --- Bootstrap helpers ---

interface BootstrapTestApp {
	app: Hono;
	bootstrap_status: {available: boolean; token_path: string | null};
	read_file: ReturnType<typeof vi.fn>;
}

// Cached PGlite factory for bootstrap tests — single WASM init, reset between calls.
const bootstrap_factory = create_pglite_factory(async (db) => {
	await run_migrations(db, [AUTH_MIGRATION_NS]);
});

/**
 * Create a bootstrap test app backed by a real in-memory PGlite.
 *
 * Uses a cached PGlite instance (via `create_pglite_factory`) to avoid
 * repeated WASM cold-start overhead. The schema is reset between calls.
 *
 * @param rate_limiter - Rate limiter to wire in (null to disable)
 * @param read_file - Override for the token file read. Defaults to returning 'wrong_token'
 *   so bootstrap always fails with `invalid_token` (status 401) in most tests.
 */
const create_bootstrap_app = async (
	ip_rate_limiter: RateLimiter | null,
	read_file = vi.fn(() => Promise.resolve('wrong_token')),
	extra?: {
		on_bootstrap?: (result: any, c: any) => Promise<void>;
		delete_file?: (path: string) => Promise<void>;
	},
): Promise<BootstrapTestApp> => {
	const db = await bootstrap_factory.create();

	const bootstrap_status = {available: true, token_path: '/fake/bootstrap_token'};

	const route_specs = create_bootstrap_route_specs(
		{
			log,
			keyring,
			password: {
				hash_password: vi.fn().mockResolvedValue('hashed_password_for_test'),
				verify_password: vi.fn().mockResolvedValue(false),
				verify_dummy: vi.fn().mockResolvedValue(false),
			},
			stat: vi.fn(() => Promise.resolve({is_file: true, is_directory: false})),
			read_file,
			delete_file: extra?.delete_file ?? vi.fn(() => Promise.resolve(undefined)),
			on_audit_event: () => {},
		},
		{
			session_options,
			bootstrap_status,
			on_bootstrap: extra?.on_bootstrap,
			ip_rate_limiter,
		},
	);

	const app = new Hono();
	app.use('*', async (c, next) => {
		c.set('pending_effects', []);
		await next();
	});
	app.use('*', test_proxy_middleware);
	apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);

	return {app, bootstrap_status, read_file};
};

const bootstrap_request = (
	app: Hono,
	headers?: Record<string, string>,
): Response | Promise<Response> =>
	app.request('/bootstrap', {
		method: 'POST',
		headers: {'Content-Type': 'application/json', ...headers},
		body: JSON.stringify({token: 'test_token', username: 'admin', password: 'secure_password_123'}),
	});

// --- Tests ---

// Warm up PGlite WASM before tests so the cold-start cost is outside individual test timers.
beforeAll(async () => {
	await bootstrap_factory.create();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('bootstrap handler rate limiting', () => {
	// Bootstrap failure: read_file returns 'wrong_token', request sends 'test_token' → token mismatch → 401
	test('returns 429 when limit exhausted', async () => {
		const limiter = create_test_limiter();
		const {app} = await create_bootstrap_app(limiter);

		// Exhaust the limit (token mismatch → 401)
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			const res = await bootstrap_request(app);
			assert.strictEqual(res.status, 401);
		}

		const res = await bootstrap_request(app);
		assert.strictEqual(res.status, 429);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_RATE_LIMIT_EXCEEDED);
		assert.strictEqual(typeof body.retry_after, 'number');
		assert.ok(body.retry_after > 0);

		limiter.dispose();
	});

	test('429 response contains only error and retry_after (no sensitive data)', async () => {
		const limiter = create_test_limiter();
		const {app} = await create_bootstrap_app(limiter);

		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			await bootstrap_request(app);
		}

		const res = await bootstrap_request(app);
		const body = await res.json();
		assert.deepStrictEqual(Object.keys(body).sort(), ['error', 'retry_after']);

		// No session cookie set on rate-limited response
		assert.strictEqual(res.headers.get('Set-Cookie'), null, '429 should not set a session cookie');

		limiter.dispose();
	});

	test('blocked request does not read token file', async () => {
		const limiter = create_test_limiter();
		const {app, read_file} = await create_bootstrap_app(limiter);

		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			await bootstrap_request(app);
		}

		const calls_before = read_file.mock.calls.length;

		// Rate-limited — handler short-circuits before bootstrap logic
		const res = await bootstrap_request(app);
		assert.strictEqual(res.status, 429);
		assert.strictEqual(
			read_file.mock.calls.length,
			calls_before,
			'should not read token file when rate-limited',
		);

		limiter.dispose();
	});

	test('failed bootstrap records an attempt', async () => {
		const limiter = create_test_limiter();
		const {app} = await create_bootstrap_app(limiter);

		await bootstrap_request(app);
		assert.strictEqual(limiter.check(TEST_CONNECTION_IP).remaining, MAX_ATTEMPTS - 1);

		limiter.dispose();
	});

	test('successful bootstrap resets the rate limit counter', async () => {
		const limiter = create_test_limiter();

		// read_file fails first 2 calls (wrong token), succeeds on 3rd (matching token)
		const read_file = vi
			.fn()
			.mockResolvedValueOnce('wrong_token')
			.mockResolvedValueOnce('wrong_token')
			.mockResolvedValue('test_token');

		const {app, bootstrap_status} = await create_bootstrap_app(limiter, read_file);

		// Accumulate failures
		await bootstrap_request(app);
		await bootstrap_request(app);
		assert.strictEqual(limiter.check(TEST_CONNECTION_IP).remaining, 1);

		// Third request: token matches, bootstrap succeeds
		const res = await bootstrap_request(app);
		assert.strictEqual(res.status, 200);

		// Rate limit fully reset
		assert.strictEqual(limiter.check(TEST_CONNECTION_IP).remaining, MAX_ATTEMPTS);

		// Bootstrap status flipped to unavailable
		assert.strictEqual(
			bootstrap_status.available,
			false,
			'bootstrap should be marked unavailable after success',
		);

		limiter.dispose();
	});

	test('rate_limiter null allows unlimited failed attempts', async () => {
		const {app} = await create_bootstrap_app(null);

		// Well beyond MAX_ATTEMPTS — should never see 429
		for (let i = 0; i < MAX_ATTEMPTS + 5; i++) {
			const res = await bootstrap_request(app);
			assert.strictEqual(res.status, 401, `request ${i + 1} should be 401, not 429`);
		}
	});

	test('X-Forwarded-For determines rate limit bucket', async () => {
		const limiter = create_test_limiter();
		const {app} = await create_bootstrap_app(limiter);

		// Exhaust limit for 10.0.0.1
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			await bootstrap_request(app, {'X-Forwarded-For': '10.0.0.1'});
		}

		// 10.0.0.1 blocked
		assert.strictEqual((await bootstrap_request(app, {'X-Forwarded-For': '10.0.0.1'})).status, 429);

		// 10.0.0.2 unaffected — different rate limit bucket
		assert.strictEqual((await bootstrap_request(app, {'X-Forwarded-For': '10.0.0.2'})).status, 401);

		limiter.dispose();
	});
});

describe('password max length validation', () => {
	const oversized_password = 'a'.repeat(PASSWORD_LENGTH_MAX + 1);

	test('bootstrap rejects password exceeding max length', async () => {
		const {app} = await create_bootstrap_app(null);
		const res = await app.request('/bootstrap', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({token: 'test_token', username: 'admin', password: oversized_password}),
		});
		assert.strictEqual(res.status, 400);
	});
});

describe('bootstrap_status.available early check', () => {
	test('returns 403 when bootstrap_status.available is false', async () => {
		const {app, bootstrap_status} = await create_bootstrap_app(null);
		bootstrap_status.available = false;

		const res = await bootstrap_request(app);
		assert.strictEqual(res.status, 403);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_ALREADY_BOOTSTRAPPED);
	});
});

describe('username validation', () => {
	test('rejects username shorter than 3 characters', async () => {
		const {app} = await create_bootstrap_app(null);
		const res = await app.request('/bootstrap', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({token: 'test_token', username: 'ab', password: 'secure_password_123'}),
		});
		assert.strictEqual(res.status, 400);
	});

	test('rejects username starting with a number', async () => {
		const {app} = await create_bootstrap_app(null);
		const res = await app.request('/bootstrap', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({
				token: 'test_token',
				username: '1admin',
				password: 'secure_password_123',
			}),
		});
		assert.strictEqual(res.status, 400);
	});

	test('rejects username containing @', async () => {
		const {app} = await create_bootstrap_app(null);
		const res = await app.request('/bootstrap', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({
				token: 'test_token',
				username: 'admin@test',
				password: 'secure_password_123',
			}),
		});
		assert.strictEqual(res.status, 400);
	});
});

describe('on_bootstrap callback error handling', () => {
	test('on_bootstrap failure does not prevent success response', async () => {
		const read_file = vi.fn().mockResolvedValue('test_token');
		const on_bootstrap = vi.fn(async () => {
			throw new Error('callback failed');
		});

		const {app} = await create_bootstrap_app(null, read_file, {on_bootstrap});

		const res = await bootstrap_request(app);
		assert.strictEqual(res.status, 200);
		assert.strictEqual(on_bootstrap.mock.calls.length, 1);
	});
});

describe('token_path null defense-in-depth', () => {
	test('returns 404 bootstrap_not_configured when available but token_path is null', async () => {
		const db = await bootstrap_factory.create();

		const bootstrap_status = {available: true, token_path: null};

		const route_specs = create_bootstrap_route_specs(
			{
				log,
				keyring,
				password: {
					hash_password: vi.fn().mockResolvedValue('hashed_password_for_test'),
					verify_password: vi.fn().mockResolvedValue(false),
					verify_dummy: vi.fn().mockResolvedValue(false),
				},
				stat: vi.fn(() => Promise.resolve({is_file: true, is_directory: false})),
				read_file: vi.fn(() => Promise.resolve('')),
				delete_file: vi.fn(() => Promise.resolve(undefined)),
				on_audit_event: () => {},
			},
			{
				session_options,
				bootstrap_status,
				ip_rate_limiter: null,
			},
		);

		const app = new Hono();
		app.use('*', async (c, next) => {
			c.set('pending_effects', []);
			await next();
		});
		app.use('*', test_proxy_middleware);
		apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);

		const res = await bootstrap_request(app);
		assert.strictEqual(res.status, 404);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_BOOTSTRAP_NOT_CONFIGURED);
	});
});

describe('token file deletion failure', () => {
	test('returns 500 when token file deletion fails', async () => {
		const read_file = vi.fn().mockResolvedValue('test_token');
		const delete_file = vi.fn().mockRejectedValue(new Error('EPERM'));

		const {app} = await create_bootstrap_app(null, read_file, {delete_file});

		const res = await bootstrap_request(app);
		assert.strictEqual(res.status, 500);
	});
});
