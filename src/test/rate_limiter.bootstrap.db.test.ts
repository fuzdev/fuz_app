/**
 * Integration tests for rate limiting through bootstrap HTTP handlers.
 *
 * Uses a real in-memory database so `bootstrap_account` runs fully.
 * Focuses on verifying that the bootstrap handler correctly integrates
 * with the RateLimiter, plus the handler's validation, the daemon-token
 * keeper it sets after its commit, and its success-audit behaviour.
 *
 * @module
 */

import { describe, test, assert, vi, afterEach, beforeAll } from 'vitest';
import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { Hono } from 'hono';
import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';

import { RateLimiter } from '#lib/rate_limiter.ts';
import { create_bootstrap_route_specs } from '#lib/auth/bootstrap_routes.ts';
import { generate_daemon_token, type DaemonTokenState } from '#lib/auth/daemon_token.ts';
import {
	create_file_bootstrap_token_store,
	type BootstrapTokenStore
} from '#lib/auth/bootstrap_token_store.ts';
import { create_node_runtime } from '#lib/runtime/node.ts';
import { BOOTSTRAP_TOKEN_LENGTH_MAX, BootstrapOutput } from '#lib/auth/bootstrap_route_schema.ts';
import { MAX_SECURE_FILE_SIZE } from '#lib/runtime/secure_file.ts';
import { apply_route_specs } from '#lib/http/route_spec.ts';
import { fuz_auth_guard_resolver } from '#lib/auth/auth_guard_resolver.ts';
import { create_session_config } from '#lib/auth/session_cookie.ts';
import { PASSWORD_LENGTH_MAX } from '#lib/auth/password.ts';
import { run_migrations } from '#lib/db/migrate.ts';
import { AUTH_MIGRATION_NS } from '#lib/auth/migrations.ts';
import { create_default_db_factory } from '#lib/testing/db.ts';
import { create_test_audit_emitter } from '#lib/testing/stubs.ts';
import { create_audit_emitter, type AuditEmitter } from '#lib/auth/audit_emitter.ts';
import { Db } from '#lib/db/db.ts';
import { flush_request_effects, create_request_tracker } from '#lib/http/pending_effects.ts';
import {
	ERROR_RATE_LIMIT_EXCEEDED,
	ERROR_ALREADY_BOOTSTRAPPED,
	ERROR_INVALID_REQUEST_BODY,
	ERROR_INVALID_TOKEN,
	ERROR_TOKEN_FILE_MISSING,
	ERROR_TOKEN_FILE_UNDELETABLE
} from '#lib/http/error_schemas.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { create_realtime_closer } from '#lib/actions/connection_closer.ts';
import { create_realtime_notification_sender } from '#lib/actions/notification_sender.ts';
import {
	create_test_limiter,
	TEST_CONNECTION_IP,
	TEST_LIMITER_MAX_ATTEMPTS,
	test_proxy_middleware
} from './rate_limiter_test_helpers.ts';
import { create_test_keyring } from './auth/session_test_helpers.ts';
import { create_gated_db, is_audit_insert, type GatedDb } from './gated_db.ts';

const log = new Logger('test', { level: 'off' });

// --- Shared fixtures ---

const keyring = create_test_keyring('integration-test-key-at-least-32-chars');
const session_options = create_session_config('test_session');

// --- Bootstrap helpers ---

interface BootstrapTestApp {
	app: Hono;
	db: Db;
	bootstrap_status: { available: boolean };
	read_token: ReturnType<typeof vi.fn>;
}

// Cached default-driver factory for bootstrap tests — single WASM init, reset between calls.
const bootstrap_factory = create_default_db_factory(async (db) => {
	await run_migrations(db, [AUTH_MIGRATION_NS]);
});

/**
 * Create a bootstrap test app backed by a real in-memory database.
 *
 * Uses a cached WASM database instance (via `create_default_db_factory`) to avoid
 * repeated WASM cold-start overhead. The schema is reset between calls.
 *
 * @param rate_limiter - Rate limiter to wire in (null to disable)
 * @param read_token - Override for the token file read. Defaults to returning 'wrong_token_wrong_token_wrong_token'
 *   so bootstrap always fails with `invalid_token` (status 401) in most tests.
 */
const create_bootstrap_app = async (
	bootstrap_ip_rate_limiter: RateLimiter | null,
	read_token = vi.fn(() =>
		Promise.resolve(new TextEncoder().encode('wrong_token_wrong_token_wrong_token'))
	),
	extra?: {
		/** The daemon-token state the route sets the keeper on. Default none. */
		daemon_token_state?: DaemonTokenState;
		/** The store's burn. Default a burn that succeeds. */
		burn_token?: BootstrapTokenStore['burn_token'];
		/** Build the audit emitter over the test db. Default a no-op emitter. */
		create_audit?: (db: Db) => AuditEmitter;
		/** Wrap the db the route runs on (a `create_gated_db`). Default the test db. */
		wrap_db?: (db: Db) => Db;
	}
): Promise<BootstrapTestApp> => {
	const db = await bootstrap_factory.create();

	const bootstrap_status = { available: true };
	const token_store: BootstrapTokenStore = {
		path: '/fake/bootstrap_token',
		read_token,
		burn_token: extra?.burn_token ?? (async () => 'burned')
	};

	const route_specs = create_bootstrap_route_specs(
		{
			log,
			keyring,
			password: {
				hash_password: vi.fn().mockResolvedValue('hashed_password_for_test'),
				verify_password: vi.fn().mockResolvedValue(false),
				verify_dummy: vi.fn().mockResolvedValue(false)
			},
			audit: extra?.create_audit?.(db) ?? create_test_audit_emitter(),
			connection_closer: create_realtime_closer(),
			notification_sender: create_realtime_notification_sender(),
			request_tracker: create_request_tracker()
		},
		{
			session_options,
			bootstrap_status,
			token_store,
			daemon_token_state: extra?.daemon_token_state ?? null,
			bootstrap_ip_rate_limiter
		}
	);

	const app = new Hono();
	app.use('*', async (c, next) => {
		c.set('pending_effects', []);
		c.set('post_commit_effects', []);
		await next();
		// as the app server's flush does, so a listener hears what committed
		await flush_request_effects(c.var.pending_effects, c.var.post_commit_effects, log);
	});
	app.use('*', test_proxy_middleware);
	// a pool-level session write is refused at once: the bootstrap mints its
	// session in its own transaction, and one written on the pool would wait
	// on the in-memory drivers' single connection until the test timed out
	const base_db = extra?.wrap_db?.(db) ?? db;
	const route_db = new Db({
		client: {
			query: async <T>(text: string, values?: Array<unknown>) => {
				if (text.includes('auth_session')) {
					throw new Error('a pool-level statement touched auth_session');
				}
				return base_db.client.query<T>(text, values);
			}
		},
		transaction: (fn) => base_db.transaction(fn)
	});
	apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, route_db);

	return { app, db, bootstrap_status, read_token };
};

const bootstrap_request = (
	app: Hono,
	headers?: Record<string, string>
): Response | Promise<Response> =>
	app.request('/bootstrap', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: JSON.stringify({
			token: 'test_token_test_token_test_token_32',
			username: 'admin',
			password: 'secure_password_123'
		})
	});

// --- Tests ---

// Warm up the database WASM before tests so the cold-start cost is outside individual test timers.
beforeAll(async () => {
	await bootstrap_factory.create();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('bootstrap handler rate limiting', () => {
	// Bootstrap failure: read_token returns 'wrong_token_wrong_token_wrong_token', request sends 'test_token_test_token_test_token_32' → token mismatch → 401
	test('returns 429 when limit exhausted', async () => {
		const limiter = create_test_limiter();
		const { app } = await create_bootstrap_app(limiter);

		// Exhaust the limit (token mismatch → 401)
		for (let i = 0; i < TEST_LIMITER_MAX_ATTEMPTS; i++) {
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
		const { app } = await create_bootstrap_app(limiter);

		for (let i = 0; i < TEST_LIMITER_MAX_ATTEMPTS; i++) {
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
		const { app, read_token } = await create_bootstrap_app(limiter);

		for (let i = 0; i < TEST_LIMITER_MAX_ATTEMPTS; i++) {
			await bootstrap_request(app);
		}

		const calls_before = read_token.mock.calls.length;

		// Rate-limited — handler short-circuits before bootstrap logic
		const res = await bootstrap_request(app);
		assert.strictEqual(res.status, 429);
		assert.strictEqual(
			read_token.mock.calls.length,
			calls_before,
			'should not read token file when rate-limited'
		);

		limiter.dispose();
	});

	test('a concurrent burst of wrong tokens gets at most the cap past the limiter', async () => {
		// Every request of the burst would pass a check made before the token
		// read; the reservation counts each one in flight, so exactly the cap
		// gets through.
		const limiter = create_test_limiter();
		const { app } = await create_bootstrap_app(limiter);

		const responses = await Promise.all(
			Array.from({ length: TEST_LIMITER_MAX_ATTEMPTS * 2 }, async () => bootstrap_request(app))
		);

		const statuses = responses.map((r) => r.status).sort((a, b) => a - b);
		assert.deepStrictEqual(statuses, [
			...Array<number>(TEST_LIMITER_MAX_ATTEMPTS).fill(401),
			...Array<number>(TEST_LIMITER_MAX_ATTEMPTS).fill(429)
		]);
		assert.strictEqual(limiter.check(TEST_CONNECTION_IP).remaining, 0);

		limiter.dispose();
	});

	test('failed bootstrap records an attempt', async () => {
		const limiter = create_test_limiter();
		const { app } = await create_bootstrap_app(limiter);

		await bootstrap_request(app);
		assert.strictEqual(limiter.check(TEST_CONNECTION_IP).remaining, TEST_LIMITER_MAX_ATTEMPTS - 1);

		limiter.dispose();
	});

	test('an unreadable token file records an attempt', async () => {
		const limiter = create_test_limiter();
		const { app } = await create_bootstrap_app(
			limiter,
			vi.fn(() => Promise.reject(new Error('ENOENT')))
		);

		const res = await bootstrap_request(app);
		assert.strictEqual(res.status, 404);
		assert.strictEqual(limiter.check(TEST_CONNECTION_IP).remaining, TEST_LIMITER_MAX_ATTEMPTS - 1);

		limiter.dispose();
	});

	test('successful bootstrap does NOT reset the rate limit counter', async () => {
		const limiter = create_test_limiter();

		// read_token fails first 2 calls (wrong token), succeeds on 3rd (matching token)
		const read_token = vi
			.fn()
			.mockResolvedValueOnce(new TextEncoder().encode('wrong_token_wrong_token_wrong_token'))
			.mockResolvedValueOnce(new TextEncoder().encode('wrong_token_wrong_token_wrong_token'))
			.mockResolvedValue(new TextEncoder().encode('test_token_test_token_test_token_32'));

		const { app, bootstrap_status } = await create_bootstrap_app(limiter, read_token);

		// Accumulate failures
		await bootstrap_request(app);
		await bootstrap_request(app);
		assert.strictEqual(limiter.check(TEST_CONNECTION_IP).remaining, 1);

		// Third request: token matches, bootstrap succeeds
		const res = await bootstrap_request(app);
		assert.strictEqual(res.status, 200);

		// `parse_or_throw` validates the `Uuid` ids + rejects extras (`object`);
		// `deepStrictEqual` pins the remaining shape and value.
		const body = parse_or_throw(BootstrapOutput, await res.json());
		assert.deepStrictEqual(body, {
			ok: true,
			account: { id: body.account.id, username: 'admin' },
			actor: { id: body.actor.id }
		});

		// The shared IP aggregate stands (see `RateLimiter.reset`). Bootstrap is
		// one-shot, so at most `max_attempts - 1` residual entries survive on the
		// operator's own address — a bounded, one-time cost for closing the
		// refund path on an instance login and password change also use.
		assert.strictEqual(
			limiter.check(TEST_CONNECTION_IP).remaining,
			1,
			'a success must not refund the shared per-IP budget'
		);

		// Bootstrap status flipped to unavailable
		assert.strictEqual(
			bootstrap_status.available,
			false,
			'bootstrap should be marked unavailable after success'
		);

		limiter.dispose();
	});

	test('rate_limiter null allows unlimited failed attempts', async () => {
		const { app } = await create_bootstrap_app(null);

		// Well beyond TEST_LIMITER_MAX_ATTEMPTS — should never see 429
		for (let i = 0; i < TEST_LIMITER_MAX_ATTEMPTS + 5; i++) {
			const res = await bootstrap_request(app);
			assert.strictEqual(res.status, 401, `request ${i + 1} should be 401, not 429`);
		}
	});

	test('X-Forwarded-For determines rate limit bucket', async () => {
		const limiter = create_test_limiter();
		const { app } = await create_bootstrap_app(limiter);

		// Exhaust limit for 10.0.0.1
		for (let i = 0; i < TEST_LIMITER_MAX_ATTEMPTS; i++) {
			await bootstrap_request(app, { 'X-Forwarded-For': '10.0.0.1' });
		}

		// 10.0.0.1 blocked
		assert.strictEqual(
			(await bootstrap_request(app, { 'X-Forwarded-For': '10.0.0.1' })).status,
			429
		);

		// 10.0.0.2 unaffected — different rate limit bucket
		assert.strictEqual(
			(await bootstrap_request(app, { 'X-Forwarded-For': '10.0.0.2' })).status,
			401
		);

		limiter.dispose();
	});

	test('an IPv6 client buckets with its /64', async () => {
		const limiter = create_test_limiter();
		const { app } = await create_bootstrap_app(limiter);

		for (let i = 0; i < TEST_LIMITER_MAX_ATTEMPTS; i++) {
			await bootstrap_request(app, { 'X-Forwarded-For': '2001:db8:1:2::1' });
		}

		// another address in the same /64 draws the same budget
		assert.strictEqual(
			(await bootstrap_request(app, { 'X-Forwarded-For': '2001:db8:1:2:8000::2' })).status,
			429
		);
		// the next /64 has its own
		assert.strictEqual(
			(await bootstrap_request(app, { 'X-Forwarded-For': '2001:db8:1:3::1' })).status,
			401
		);

		limiter.dispose();
	});
});

describe('unreadable token file closes the window', () => {
	test('the second attempt takes the write-free closed-window path', async () => {
		// Bootstrap can't succeed without a readable token, and
		// `check_bootstrap_status` already reads an unreadable file as
		// unavailable at startup — so leaving the flag set means the two
		// disagree, and every later request writes another audit row. The
		// limiter would bound that channel; closing it ends it. Twin of the
		// Rust spine's `bootstrap_handler`. `null` limiter so the assertion is
		// about the window, not about the bucket absorbing the flood.
		const unreadable = vi.fn(() => Promise.reject(new Error('ENOENT')));
		const { app, bootstrap_status } = await create_bootstrap_app(null, unreadable);

		const first = await bootstrap_request(app);
		assert.strictEqual(first.status, 404);
		assert.strictEqual((await first.json()).error, ERROR_TOKEN_FILE_MISSING);
		assert.isFalse(bootstrap_status.available, 'an unreadable token file must close the window');

		const second = await bootstrap_request(app);
		assert.strictEqual(second.status, 403);
		assert.strictEqual((await second.json()).error, ERROR_ALREADY_BOOTSTRAPPED);
		assert.strictEqual(
			unreadable.mock.calls.length,
			1,
			'the closed window short-circuits before the token read'
		);
	});
});

describe('password max length validation', () => {
	const oversized_password = 'a'.repeat(PASSWORD_LENGTH_MAX + 1);

	test('bootstrap rejects password exceeding max length', async () => {
		const { app } = await create_bootstrap_app(null);
		const res = await app.request('/bootstrap', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				token: 'test_token_test_token_test_token_32',
				username: 'admin',
				password: oversized_password
			})
		});
		assert.strictEqual(res.status, 400);
	});
});

describe('token max length validation', () => {
	const astral = '\u{1F600}';
	// each at the cap in UTF-16 code units: ASCII, two-byte, and astral
	const at_max = [
		'x'.repeat(BOOTSTRAP_TOKEN_LENGTH_MAX),
		'\u00e9'.repeat(BOOTSTRAP_TOKEN_LENGTH_MAX),
		astral.repeat(BOOTSTRAP_TOKEN_LENGTH_MAX / 2)
	];
	// each one unit past it, or one astral character, two units
	const over_max = [
		'x'.repeat(BOOTSTRAP_TOKEN_LENGTH_MAX + 1),
		'\u00e9'.repeat(BOOTSTRAP_TOKEN_LENGTH_MAX + 1),
		astral.repeat(BOOTSTRAP_TOKEN_LENGTH_MAX / 2) + 'a',
		astral.repeat(BOOTSTRAP_TOKEN_LENGTH_MAX / 2 + 1)
	];

	/** POST a bootstrap with `token` to an app whose audit rows land in its db. */
	const attempt = async (token: string) => {
		let audit: AuditEmitter | undefined;
		const test_app = await create_bootstrap_app(null, undefined, {
			create_audit: (audit_db) => (audit = create_audit_emitter({ db: audit_db, log }))
		});
		const res = await test_app.app.request('/bootstrap', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ token, username: 'admin', password: 'secure_password_123' })
		});
		const body = await res.json();
		assert.ok(audit);
		await audit.drain_inflight();
		const audit_rows = await test_app.db.query<{ outcome: string }>(
			"SELECT outcome FROM audit_log WHERE event_type = 'bootstrap'"
		);
		return { res, body, audit_rows, read_token: test_app.read_token };
	};

	test('the cap is the token file cap', () => {
		assert.strictEqual(BOOTSTRAP_TOKEN_LENGTH_MAX, MAX_SECURE_FILE_SIZE);
	});

	test('a token at the cap in code units passes validation to the compare', async () => {
		for (const token of at_max) {
			assert.strictEqual(token.length, BOOTSTRAP_TOKEN_LENGTH_MAX);
			const { res, body, audit_rows, read_token } = await attempt(token);
			assert.strictEqual(res.status, 401, `${token.length} units`);
			assert.strictEqual(body.error, ERROR_INVALID_TOKEN);
			assert.strictEqual(read_token.mock.calls.length, 1);
			assert.deepStrictEqual(
				audit_rows.map((r) => r.outcome),
				['failure'],
				'the wrong token writes its failure row'
			);
		}
	});

	test('a token past the cap is a malformed body: 400, no token read, no audit row', async () => {
		for (const token of over_max) {
			assert.ok(token.length > BOOTSTRAP_TOKEN_LENGTH_MAX);
			const { res, body, audit_rows, read_token } = await attempt(token);
			assert.strictEqual(res.status, 400, `${token.length} units`);
			assert.strictEqual(body.error, ERROR_INVALID_REQUEST_BODY);
			assert.strictEqual(read_token.mock.calls.length, 0, 'the token file is never read');
			assert.deepStrictEqual(audit_rows, [], 'a malformed body writes no audit row');
		}
	});
});

describe('bootstrap_status.available early check', () => {
	test('returns 403 when bootstrap_status.available is false', async () => {
		const { app, bootstrap_status } = await create_bootstrap_app(null);
		bootstrap_status.available = false;

		const res = await bootstrap_request(app);
		assert.strictEqual(res.status, 403);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_ALREADY_BOOTSTRAPPED);
	});
});

describe('username validation', () => {
	test('rejects username shorter than 3 characters', async () => {
		const { app } = await create_bootstrap_app(null);
		const res = await app.request('/bootstrap', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				token: 'test_token_test_token_test_token_32',
				username: 'ab',
				password: 'secure_password_123'
			})
		});
		assert.strictEqual(res.status, 400);
	});

	test('rejects username starting with a number', async () => {
		const { app } = await create_bootstrap_app(null);
		const res = await app.request('/bootstrap', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				token: 'test_token_test_token_test_token_32',
				username: '1admin',
				password: 'secure_password_123'
			})
		});
		assert.strictEqual(res.status, 400);
	});

	test('rejects username containing @', async () => {
		const { app } = await create_bootstrap_app(null);
		const res = await app.request('/bootstrap', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				token: 'test_token_test_token_test_token_32',
				username: 'admin@test',
				password: 'secure_password_123'
			})
		});
		assert.strictEqual(res.status, 400);
	});
});

describe('bootstrap success audit', () => {
	test('a successful bootstrap writes one success audit row for the new account', async () => {
		const read_token = vi
			.fn()
			.mockResolvedValue(new TextEncoder().encode('test_token_test_token_test_token_32'));
		let audit: AuditEmitter | undefined;
		const { app, db } = await create_bootstrap_app(null, read_token, {
			create_audit: (audit_db) => (audit = create_audit_emitter({ db: audit_db, log }))
		});

		const res = await bootstrap_request(app);
		assert.strictEqual(res.status, 200);
		const body = parse_or_throw(BootstrapOutput, await res.json());
		assert.strictEqual(body.ok, true);
		assert.strictEqual(body.account.username, 'admin');

		assert.ok(audit);
		await audit.drain_inflight();
		const rows = await db.query<{
			event_type: string;
			outcome: string;
			actor_id: string | null;
			account_id: string | null;
			ip: string | null;
			metadata: unknown;
		}>(
			"SELECT event_type, outcome, actor_id, account_id, ip, metadata FROM audit_log WHERE event_type = 'bootstrap'"
		);
		assert.strictEqual(rows.length, 1);
		const [row] = rows;
		assert.ok(row);
		assert.strictEqual(row.outcome, 'success');
		assert.strictEqual(row.account_id, body.account.id);
		assert.strictEqual(row.actor_id, body.actor.id);
		assert.strictEqual(row.ip, TEST_CONNECTION_IP);
		assert.strictEqual(row.metadata, null);
	});
});

const MATCHING_TOKEN = () =>
	vi.fn(() => Promise.resolve(new TextEncoder().encode('test_token_test_token_test_token_32')));

/** An app over `read_token` whose audit rows land in its db, with a drain. */
const create_audited_bootstrap_app = async (
	limiter: RateLimiter | null,
	read_token: ReturnType<typeof MATCHING_TOKEN>,
	extra?: {
		burn_token?: BootstrapTokenStore['burn_token'];
		daemon_token_state?: DaemonTokenState;
	}
) => {
	let audit: AuditEmitter | undefined;
	const test_app = await create_bootstrap_app(limiter, read_token, {
		...extra,
		create_audit: (audit_db) => (audit = create_audit_emitter({ db: audit_db, log }))
	});
	const read_audit = async () => {
		assert.ok(audit);
		await audit.drain_inflight();
		return test_app.db.query<{ outcome: string; metadata: unknown }>(
			"SELECT outcome, metadata FROM audit_log WHERE event_type = 'bootstrap' ORDER BY seq"
		);
	};
	return { ...test_app, read_audit };
};

describe('the session bootstrap mints', () => {
	test('a success sets the cookie of the session minted in the transaction', async () => {
		const { app, db } = await create_bootstrap_app(null, MATCHING_TOKEN());

		const res = await bootstrap_request(app);
		assert.strictEqual(res.status, 200);
		const body = parse_or_throw(BootstrapOutput, await res.json());
		const cookies = res.headers.getSetCookie();
		assert.strictEqual(cookies.length, 1);
		assert.ok(cookies[0]!.startsWith('test_session='));
		const sessions = await db.query<{ account_id: string }>('SELECT account_id FROM auth_session');
		assert.deepEqual(
			sessions.map((r) => r.account_id),
			[body.account.id]
		);
	});
});

const create_keeperless_daemon_token_state = (): DaemonTokenState => ({
	current_token: generate_daemon_token(),
	previous_token: null,
	rotated_at: new Date(),
	keeper_account_id: null
});

describe('the daemon-token keeper', () => {
	test('a successful bootstrap sets the keeper, after its commit', async () => {
		const daemon_token_state = create_keeperless_daemon_token_state();
		let gated: GatedDb | undefined;
		const { app } = await create_bootstrap_app(null, MATCHING_TOKEN(), {
			daemon_token_state,
			wrap_db: (inner) => (gated = create_gated_db(inner)).db
		});
		assert.ok(gated);
		const held = gated.hold_commit();

		const pending = bootstrap_request(app);
		await held.reached;
		assert.strictEqual(
			daemon_token_state.keeper_account_id,
			null,
			'nothing is set while the bootstrap is uncommitted'
		);
		held.release();
		const res = await pending;
		assert.strictEqual(res.status, 200);
		const body = parse_or_throw(BootstrapOutput, await res.json());
		assert.strictEqual(daemon_token_state.keeper_account_id, body.account.id);
	});

	test('a bootstrap whose commit fails leaves the keeper null', async () => {
		const daemon_token_state = create_keeperless_daemon_token_state();
		let gated: GatedDb | undefined;
		const { app, db } = await create_bootstrap_app(null, MATCHING_TOKEN(), {
			daemon_token_state,
			wrap_db: (inner) => (gated = create_gated_db(inner)).db
		});
		assert.ok(gated);
		const held = gated.hold_commit();

		const pending = bootstrap_request(app);
		await held.reached;
		held.fail(new Error('commit refused'));
		const res = await pending;
		assert.strictEqual(res.status, 500);
		assert.strictEqual((await db.query('SELECT id FROM account')).length, 0);
		assert.strictEqual(daemon_token_state.keeper_account_id, null);
	});

	test('a bootstrap rolled back on its burn leaves the keeper null', async () => {
		const daemon_token_state = create_keeperless_daemon_token_state();
		const { app } = await create_bootstrap_app(null, MATCHING_TOKEN(), {
			daemon_token_state,
			burn_token: async () => {
				throw new Error('EACCES: permission denied');
			}
		});

		const res = await bootstrap_request(app);
		assert.strictEqual(res.status, 500);
		assert.strictEqual(daemon_token_state.keeper_account_id, null);
	});

	test('a refused bootstrap leaves the keeper null', async () => {
		const daemon_token_state = create_keeperless_daemon_token_state();
		const { app } = await create_bootstrap_app(null, undefined, { daemon_token_state });

		const res = await bootstrap_request(app);
		assert.strictEqual(res.status, 401);
		assert.strictEqual(daemon_token_state.keeper_account_id, null);
	});
});

describe('token file burn failure', () => {
	test('answers 500 token_file_undeletable, rolls back, and leaves the window open', async () => {
		const limiter = create_test_limiter();
		const { app, db, bootstrap_status, read_audit } = await create_audited_bootstrap_app(
			limiter,
			MATCHING_TOKEN(),
			{
				burn_token: async () => {
					throw new Error('EACCES: permission denied');
				}
			}
		);

		const res = await bootstrap_request(app);
		assert.strictEqual(res.status, 500);
		assert.deepStrictEqual(await res.json(), { error: ERROR_TOKEN_FILE_UNDELETABLE });
		assert.strictEqual(
			res.headers.get('Set-Cookie'),
			null,
			'no session for a rolled-back bootstrap'
		);
		assert.isTrue(bootstrap_status.available, 'the operator retries without a restart');
		const accounts = await db.query('SELECT id FROM account');
		assert.strictEqual(accounts.length, 0, 'nothing was created');
		const sessions = await db.query('SELECT id FROM auth_session');
		assert.strictEqual(sessions.length, 0);
		assert.deepStrictEqual(await read_audit(), [
			{ outcome: 'failure', metadata: { error: ERROR_TOKEN_FILE_UNDELETABLE } }
		]);
		assert.strictEqual(
			limiter.check(TEST_CONNECTION_IP).remaining,
			TEST_LIMITER_MAX_ATTEMPTS - 1,
			'the refusal is charged'
		);

		limiter.dispose();
	});
});

describe('the bootstrap success row is written in its transaction', () => {
	test('a refused audit row rolls the bootstrap back: no account, lock unflipped, token unburned', async () => {
		let gated: GatedDb | undefined;
		const burns: Array<string> = [];
		const { app, db, bootstrap_status } = await create_bootstrap_app(null, MATCHING_TOKEN(), {
			create_audit: (audit_db) => create_audit_emitter({ db: audit_db, log }),
			wrap_db: (inner) => (gated = create_gated_db(inner)).db,
			burn_token: async () => {
				burns.push('burn');
				return 'burned';
			}
		});
		assert.ok(gated);
		gated.refuse_in_transaction(is_audit_insert, new Error('audit insert refused'));

		const res = await bootstrap_request(app);
		assert.strictEqual(res.status, 500);
		assert.strictEqual(
			res.headers.get('Set-Cookie'),
			null,
			'no session for a rolled-back bootstrap'
		);
		assert.strictEqual((await db.query('SELECT id FROM account')).length, 0, 'nothing was created');
		assert.strictEqual((await db.query('SELECT id FROM auth_session')).length, 0);
		const lock = await db.query_one<{ bootstrapped: boolean }>(
			'SELECT bootstrapped FROM bootstrap_lock WHERE id = 1'
		);
		assert.strictEqual(lock?.bootstrapped, false, 'the lock flip rolled back');
		assert.deepStrictEqual(
			burns,
			[],
			'the token is still there — the row is written before the burn'
		);
		assert.isTrue(bootstrap_status.available, 'the window stays open');
	});

	test('a burn that fails after the success row announces no success row', async () => {
		const heard: Array<string> = [];
		const { app, db } = await create_bootstrap_app(null, MATCHING_TOKEN(), {
			create_audit: (audit_db) =>
				create_audit_emitter({
					db: audit_db,
					log,
					on_audit_event: (event) => heard.push(`${event.event_type} ${event.outcome}`)
				}),
			burn_token: async () => {
				throw new Error('EACCES: permission denied');
			}
		});

		const res = await bootstrap_request(app);
		assert.strictEqual(res.status, 500);
		assert.deepStrictEqual(await res.json(), { error: ERROR_TOKEN_FILE_UNDELETABLE });
		// the handler answers the refusal without throwing, so only the
		// bootstrap transaction's own discard keeps its success row's
		// announcement from firing
		assert.deepStrictEqual(heard, ['bootstrap failure'], 'only the failure row is announced');
		const rows = await db.query<{ outcome: string }>(
			"SELECT outcome FROM audit_log WHERE event_type = 'bootstrap'"
		);
		assert.deepStrictEqual(
			rows.map((r) => r.outcome),
			['failure'],
			'the success row rolled back with the bootstrap'
		);
	});
});

describe('the lock-race loser', () => {
	test('closes the window, writes no audit row, and is not charged', async () => {
		const limiter = create_test_limiter();
		const { app, db, bootstrap_status, read_audit } = await create_audited_bootstrap_app(
			limiter,
			MATCHING_TOKEN()
		);
		// the window open in memory, the lock already flipped in the database
		await db.query('UPDATE bootstrap_lock SET bootstrapped = true WHERE id = 1');

		const res = await bootstrap_request(app);
		assert.strictEqual(res.status, 403);
		assert.deepStrictEqual(await res.json(), { error: ERROR_ALREADY_BOOTSTRAPPED });
		assert.isFalse(bootstrap_status.available, 'the window closes');
		assert.deepStrictEqual(await read_audit(), [], 'no audit row');
		assert.strictEqual(
			limiter.check(TEST_CONNECTION_IP).remaining,
			TEST_LIMITER_MAX_ATTEMPTS,
			'the loser is not charged'
		);

		limiter.dispose();
	});
});

describe.runIf(process.platform !== 'win32')('a token file with a second hard link', () => {
	test('answers as an unreadable token: 404, the window closed, nothing created, the file kept', async () => {
		// The burn is an unlink, which leaves an inode with another name readable
		// under it — so the store's read refuses the file, the right token
		// included, and the request takes the unreadable-token leg.
		const dir = mkdtempSync(join(tmpdir(), 'fuz-bootstrap-links-'));
		try {
			const path = join(dir, 'bootstrap_token');
			const content = 'test_token_test_token_test_token_32\n';
			writeFileSync(path, content);
			chmodSync(path, 0o600);
			linkSync(path, join(dir, 'other_name'));
			const store = create_file_bootstrap_token_store(create_node_runtime(), path);
			const { app, db, bootstrap_status } = await create_bootstrap_app(
				null,
				vi.fn(async () => new Uint8Array(await store.read_token()))
			);

			const res = await bootstrap_request(app);
			assert.strictEqual(res.status, 404);
			assert.strictEqual((await res.json()).error, ERROR_TOKEN_FILE_MISSING);
			assert.isFalse(bootstrap_status.available, 'the refusal closes the window');
			const row = await db.query_one<{ n: number }>('SELECT COUNT(*)::int AS n FROM account');
			assert.strictEqual(row?.n, 0);
			assert.strictEqual(readFileSync(path, 'utf8'), content, 'the refused token stays');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
