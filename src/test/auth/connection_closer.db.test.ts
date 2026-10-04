/**
 * Coverage for the connection closes every revocation makes — the self-service
 * account actions, the admin revoke-all / delete / purge actions, the REST
 * login / logout / password routes, and the session and token caps.
 *
 * Asserts that:
 * 1. Every revoking handler closes the right connections through
 *    `deps.connection_closer` — `assert_close_call(calls[n], method, id)`
 *    pins `{method, id}`.
 * 2. The close runs **after the handler's transaction commits**. The
 *    `every revocation site` block drives each site over a `create_gated_db`
 *    and has its closer probe record two things at the moment it is called:
 *    how many transactions are open (zero), and what a read through the
 *    *pool* sees (the revocation, committed). On PGlite a pool read during an
 *    open transaction would queue behind it, so the open-transaction count is
 *    what discriminates there; on real Postgres the pool read does too.
 * 3. A handler that throws closes nothing — its transaction rolled back, so
 *    the revocation never happened.
 * 4. A failed audit INSERT still closes — the close does not ride on the
 *    fail-open audit write.
 * 5. The close reaches both transports: a real `BackendWebsocketTransport`
 *    socket and a real audit-stream `SubscriberRegistry` stream registered
 *    under the revoked identity both end, and a bystander's do not.
 * 6. Failure outcomes (revoked=false from IDOR mismatch or cross-account
 *    probe) close nothing — attackers cannot target arbitrary sessions/tokens
 *    by guessing ids OR by passing real other-account ids.
 * 7. The close does not wait for the audit write either — with the audit
 *    INSERT held in flight, an HTTP revocation's close has run, and a
 *    WebSocket that revoked its own sessions is closed and dispatches nothing
 *    more.
 * 8. An RPC revocation that committed but whose result cannot be serialized
 *    still closes — the response failure is not read as a rollback.
 * 9. Every test runs under the `beforeEach`/`afterEach` audit-drift
 *    guard at the top of `describe_db`: if any handler emits metadata
 *    that fails `audit_metadata_schemas`, the process-wide counter in
 *    `audit_log_queries.ts` bumps and the after-each assertion fails.
 *    Same shape for unknown `event_type` values. Catches regressions
 *    that production would swallow (the schema validation is
 *    fail-open in `query_audit_log`).
 *
 * The interleaving the post-commit order exists for — a connection admitted
 * while a revocation's transaction is still open — needs two database
 * connections, so it lives in `connection_closer.admission.db.test.ts`, on
 * real Postgres only.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';
import { wait } from '@fuzdev/fuz_util/async.ts';

import { SessionId } from '$lib/auth/account_schema.ts';
import { create_session_config } from '$lib/auth/session_cookie.ts';
import { create_account_route_specs } from '$lib/auth/account_routes.ts';
import { create_account_actions } from '$lib/auth/account_actions.ts';
import { create_admin_actions } from '$lib/auth/admin_actions.ts';
import { create_standard_rpc_actions } from '$lib/auth/standard_rpc_actions.ts';
import {
	account_session_revoke_action_spec,
	account_session_revoke_all_action_spec,
	account_token_revoke_action_spec
} from '$lib/auth/account_action_specs.ts';
import {
	admin_session_revoke_all_action_spec,
	admin_token_revoke_all_action_spec
} from '$lib/auth/admin_action_specs.ts';
import {
	ERROR_CREDENTIAL_TYPE_REQUIRED,
	ERROR_ACCOUNT_NOT_FOUND
} from '$lib/http/error_schemas.ts';
import { create_rpc_endpoint, rpc_action } from '$lib/actions/action_rpc.ts';
import type { RequestResponseActionSpec } from '$lib/actions/action_spec.ts';
import { queue_connection_close, type ConnectionCloser } from '$lib/actions/connection_closer.ts';
import { register_action_ws } from '$lib/actions/register_action_ws.ts';
import { BackendWebsocketTransport } from '$lib/actions/transports_ws_backend.ts';
import {
	WS_CLOSE_SESSION_REVOKED,
	WS_CLOSE_SESSION_REVOKED_REASON
} from '$lib/actions/transports.ts';
import { create_test_app, type TestApp } from '$lib/testing/app_server.ts';
import { DEFAULT_TEST_PASSWORD } from '$lib/testing/test_credentials.ts';
import { create_test_account_with_actor } from '$lib/testing/db_entities.ts';
import { rpc_call_for_spec, rpc_call } from '$lib/testing/rpc_helpers.ts';
import { find_auth_route } from '$lib/testing/integration_helpers.ts';
import { install_audit_drift_guard } from '$lib/testing/audit_drift_guard.ts';
import { create_audit_emitter } from '$lib/auth/audit_emitter.ts';
import {
	assert_close_call,
	create_recording_closer
} from '$lib/testing/connection_closer_helpers.ts';
import {
	create_fake_ws,
	create_stub_upgrade,
	dispatch_ws_message,
	type FakeWs
} from '$lib/testing/ws_round_trip.ts';
import {
	AUTH_SESSION_TOKEN_HASH_KEY,
	build_account_context,
	REQUEST_CONTEXT_KEY
} from '$lib/auth/request_context.ts';
import { query_session_revoke_all_for_account } from '$lib/auth/session_queries.ts';
import { ACCOUNT_ID_KEY, CREDENTIAL_TYPE_KEY } from '$lib/hono_context.ts';
import { JSONRPC_ERROR_CODES } from '$lib/http/jsonrpc_errors.ts';
import { Db } from '$lib/db/db.ts';
import type { AppServerContext } from '$lib/server/app_server_context.ts';
import { prefix_route_specs, type RouteSpec } from '$lib/http/route_spec.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from '$lib/auth/role_schema.ts';
import type { AuditLogEvent } from '$lib/auth/audit_log_schema.ts';
import type { AuditLogSse } from '$lib/realtime/sse_auth_guard.ts';
import type { SseNotification, SseStream } from '$lib/realtime/sse.ts';

import { describe_db } from '../db_fixture.ts';
import { create_gated_db, type GatedDb } from '../gated_db.ts';

const session_options = create_session_config('test_session');
const RPC_PATH = '/api/rpc';
const log = new Logger('test', { level: 'off' });

/** Matches the audit emitter's pool write. */
const is_audit_insert = (sql: string): boolean => sql.includes('INSERT INTO audit_log');

/** Poll until `predicate` holds, failing with `message` after two seconds. */
const until = async (predicate: () => boolean, message: string): Promise<void> => {
	const deadline = Date.now() + 2000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, message);
		await wait(5);
	}
};

/**
 * The account routes and the account + admin actions, built from `ctx.deps`
 * the way a consumer builds them, with `closer` added to the backend's
 * `connection_closer` so the test sees every close the handlers make.
 */
const make_create_route_specs =
	(closer: ConnectionCloser, options: { max_sessions?: number; max_tokens?: number } = {}) =>
	(ctx: AppServerContext): Array<RouteSpec> => {
		ctx.deps.connection_closer.add(closer);
		return [
			...prefix_route_specs(
				'/api/account',
				create_account_route_specs(ctx.deps, {
					session_options,
					login_ip_rate_limiter: ctx.login_ip_rate_limiter,
					login_account_rate_limiter: ctx.login_account_rate_limiter,
					login_fail_floor_ms: 0,
					max_sessions: options.max_sessions
				})
			),
			...create_rpc_endpoint({
				path: RPC_PATH,
				actions: [
					...create_account_actions(ctx.deps, { max_tokens: options.max_tokens }),
					...create_admin_actions(ctx.deps)
				],
				log: ctx.deps.log
			})
		];
	};

describe_db('connection_closer wiring', (get_db) => {
	// Audit-drift guard — fails any test whose audit emits land an
	// undeclared metadata field or an unknown event_type (production
	// validation in `query_audit_log` is fail-open; without this we'd
	// silently swallow the same regressions). See
	// `testing/audit_drift_guard.ts`. `await_pending_effects: true` on
	// the test app guarantees fire-and-forget audit writes have completed
	// by response time, so the after-each check observes final state. The
	// same flush runs the post-commit queue, so every close a handler queued
	// has run by the time its response is in hand.
	install_audit_drift_guard();

	describe('account_actions (self-service)', () => {
		test('account_session_revoke closes the session socket on success', async () => {
			const { closer, calls } = create_recording_closer();
			const audit_events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				audit_factory: (params) =>
					create_audit_emitter({ ...params, on_audit_event: (e) => audit_events.push(e) })
			});

			// Discover the active session's id (= blake3 hash) via the
			// account_session_list RPC — that's the public surface a real
			// caller would use to know what to pass to session_revoke. The
			// raw session token isn't exposed by the test fixture; the
			// signed cookie value isn't the token.
			const list_res = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: 'account_session_list',
				headers: test_app.create_session_headers()
			});
			assert.strictEqual(list_res.ok, true);
			const listed = list_res.ok
				? (list_res.result as { sessions: Array<{ id: string }> })
				: { sessions: [] };
			assert.strictEqual(listed.sessions.length, 1, 'exactly one bootstrap session expected');
			const session_id = listed.sessions[0]!.id;

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_session_revoke_action_spec,
				params: { session_id: session_id as never },
				headers: test_app.create_session_headers()
			});
			assert.strictEqual(res.ok, true);
			assert.strictEqual(calls.length, 1, 'connection_closer called exactly once');
			assert_close_call(calls[0], 'session', session_id);

			// Audit emit fires fire-and-forget; with `await_pending_effects: true`,
			// it lands by response time.
			const session_revoke_audits = audit_events.filter((e) => e.event_type === 'session_revoke');
			assert.strictEqual(session_revoke_audits.length, 1);
			assert.strictEqual(session_revoke_audits[0]!.outcome, 'success');
			// Pin the metadata shape on success — `session_id` carries the
			// revoked hash, `credential_type` is the defense-in-depth field
			// from `docs/security.md` §Credential-channel gating. Without
			// these, a refactor dropping either field passes the count check
			// but breaks forensics.
			const meta = session_revoke_audits[0]!.metadata as {
				session_id?: string;
				credential_type?: string;
			};
			assert.strictEqual(meta.session_id, session_id);
			assert.strictEqual(meta.credential_type, 'session');

			await test_app.cleanup();
		});

		test('account_session_revoke does NOT close on failure (id mismatch)', async () => {
			const { closer, calls } = create_recording_closer();
			const audit_events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				audit_factory: (params) =>
					create_audit_emitter({ ...params, on_audit_event: (e) => audit_events.push(e) })
			});
			// blake3 hash format but not a real session
			const bogus_hash = SessionId.parse('a'.repeat(64));
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_session_revoke_action_spec,
				params: { session_id: bogus_hash },
				headers: test_app.create_session_headers()
			});
			assert.strictEqual(res.ok, true);
			if (res.ok) assert.strictEqual(res.result.revoked, false);
			assert.strictEqual(
				calls.length,
				0,
				'closer must NOT fire on failed revoke — attacker-guessable ids'
			);
			// Pin the failure-outcome audit row — without it, a regression dropping
			// BOTH the close AND the failure audit would slip past the close-
			// only assertion above. The attacker-supplied `session_id` echoes back
			// into metadata so forensics can spot enumeration attempts.
			const failure_audits = audit_events.filter(
				(e) => e.event_type === 'session_revoke' && e.outcome === 'failure'
			);
			assert.strictEqual(failure_audits.length, 1);
			const meta = failure_audits[0]!.metadata as { session_id?: string };
			assert.strictEqual(meta.session_id, bogus_hash);
			await test_app.cleanup();
		});

		test('account_session_revoke does NOT close on cross-account IDOR (real other-account session)', async () => {
			// Sibling to the id-mismatch test above. The mismatch case proves
			// `revoked: false` when the row is genuinely missing; this proves
			// the same when the row EXISTS but belongs to another account.
			// Both paths go through `query_session_revoke_for_account` and
			// rely on the `account_id` predicate in the SQL — a regression
			// that swapped to `query_session_revoke_by_hash_unscoped` (the
			// logout variant) would still return `revoked: true` on the
			// missing-row case here (because the row was genuinely absent)
			// but would now reveal a *real* session belonging to another
			// account. Only the cross-account variant catches that.
			const { closer, calls } = create_recording_closer();
			const audit_events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				audit_factory: (params) =>
					create_audit_emitter({ ...params, on_audit_event: (e) => audit_events.push(e) })
			});
			const target = await test_app.create_account({ username: 'crossaccttarget' });
			// Discover the target's session id via the list RPC against the
			// target's own headers — same dance as the happy-path test above.
			const list_res = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: 'account_session_list',
				headers: target.create_session_headers()
			});
			assert.strictEqual(list_res.ok, true);
			const listed = list_res.ok
				? (list_res.result as { sessions: Array<{ id: string }> })
				: { sessions: [] };
			assert.strictEqual(listed.sessions.length, 1, 'target has one session');
			const target_session_id = listed.sessions[0]!.id;
			// Reset call log — the list call doesn't close, but be defensive.
			calls.length = 0;

			// First account (bootstrap session) attempts to revoke the target's session.
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_session_revoke_action_spec,
				params: { session_id: target_session_id as never },
				headers: test_app.create_session_headers()
			});
			assert.strictEqual(res.ok, true);
			if (res.ok) assert.strictEqual(res.result.revoked, false);
			assert.strictEqual(
				calls.length,
				0,
				'closer must NOT fire on cross-account revoke — IDOR via the closer would be a worse leak than the audit row'
			);

			// Target session is still alive — IDOR didn't bypass the guard at the SQL level either.
			const target_list_after = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: 'account_session_list',
				headers: target.create_session_headers()
			});
			assert.strictEqual(target_list_after.ok, true);
			const target_listed_after = target_list_after.ok
				? (target_list_after.result as { sessions: Array<{ id: string }> })
				: { sessions: [] };
			assert.strictEqual(
				target_listed_after.sessions.length,
				1,
				'target session still alive after cross-account revoke attempt'
			);

			// Failure-outcome audit fires under the first account_id with the
			// probed session_id in metadata — matches the id-mismatch shape.
			const failure_audits = audit_events.filter(
				(e) => e.event_type === 'session_revoke' && e.outcome === 'failure'
			);
			assert.strictEqual(failure_audits.length, 1);
			const meta = failure_audits[0]!.metadata as { session_id?: string };
			assert.strictEqual(meta.session_id, target_session_id);
			assert.strictEqual(
				failure_audits[0]!.account_id,
				test_app.backend.account.id,
				'audit pins the calling account, not the target'
			);
			await test_app.cleanup();
		});

		test('account_session_revoke_all closes the account', async () => {
			// `count` is always ≥ 1 on this surface — the caller is using the
			// session they're revoking. The "count: 0, close still fires"
			// contract is admin-only (admin can target any account, including
			// ones with no live sessions); the self-service surface can't
			// reach the count-zero branch from the public API.
			const { closer, calls } = create_recording_closer();
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db()
			});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_session_revoke_all_action_spec,
				params: undefined,
				headers: test_app.create_session_headers()
			});
			assert.strictEqual(res.ok, true);
			if (res.ok)
				assert.strictEqual(res.result.count, 1, 'bootstrap session was the only active session');
			assert.strictEqual(calls.length, 1);
			assert_close_call(calls[0], 'account', test_app.backend.account.id);
			await test_app.cleanup();
		});

		test('account_token_revoke closes the token socket on success', async () => {
			const { closer, calls } = create_recording_closer();
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db()
			});
			// Create a fresh token via the RPC surface so we have its id —
			// the test_app fixture's `api_token` is the raw token string only.
			const create_res = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: 'account_token_create',
				params: { name: 'closer_target', scope: { kind: 'full' }, lifetime: { kind: 'eternal' } },
				headers: test_app.create_session_headers()
			});
			assert.strictEqual(create_res.ok, true);
			const created = create_res.ok ? (create_res.result as { id: string }) : { id: '' };
			const token_id = created.id;
			// `account_token_create` must NOT fire the closer — it's a
			// creation, not a revocation. Without this pin, a copy-paste
			// refactor that wired the closer into the create handler would
			// pass the revoke assertion below (`calls.length === 1` after
			// the reset) but silently emit a spurious close call for every
			// new token. The reset below would mask the regression.
			assert.strictEqual(calls.length, 0, 'token_create must NOT fire the closer');
			// Reset call log so we only capture the revoke's close.
			calls.length = 0;

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_token_revoke_action_spec,
				params: { token_id: token_id as never },
				headers: test_app.create_session_headers()
			});
			assert.strictEqual(res.ok, true);
			// Pin `revoked: true` on the success path — without this, a
			// regression where the query returned `false` but the handler
			// still fired the close would pass (`calls.length === 1`) silently.
			if (res.ok) assert.strictEqual(res.result.revoked, true);
			assert.strictEqual(calls.length, 1);
			assert_close_call(calls[0], 'token', token_id);
			await test_app.cleanup();
		});

		test('account_token_revoke does NOT close on failure (id mismatch)', async () => {
			const { closer, calls } = create_recording_closer();
			const audit_events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				audit_factory: (params) =>
					create_audit_emitter({ ...params, on_audit_event: (e) => audit_events.push(e) })
			});
			const bogus_token = 'tok_aaaaaaaaaaaa';
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_token_revoke_action_spec,
				params: { token_id: bogus_token },
				headers: test_app.create_session_headers()
			});
			assert.strictEqual(res.ok, true);
			if (res.ok) assert.strictEqual(res.result.revoked, false);
			assert.strictEqual(calls.length, 0);
			// Symmetric to the `account_session_revoke` failure-audit pin above —
			// a regression that dropped close AND failure audit together would
			// otherwise pass.
			const failure_audits = audit_events.filter(
				(e) => e.event_type === 'token_revoke' && e.outcome === 'failure'
			);
			assert.strictEqual(failure_audits.length, 1);
			const meta = failure_audits[0]!.metadata as { token_id?: string };
			assert.strictEqual(meta.token_id, bogus_token);
			await test_app.cleanup();
		});

		test('account_token_revoke does NOT close on cross-account IDOR (real other-account token)', async () => {
			// Sibling to the id-mismatch test above. Same reasoning as the
			// `account_session_revoke` cross-account variant: the mismatch
			// case proves `revoked: false` when the row is missing; this
			// proves it when the row EXISTS but belongs to another account.
			// A regression that swapped `query_revoke_api_token_for_account`
			// for an unscoped variant would still pass the missing-row case
			// but would silently leak (and revoke) real other-account tokens.
			const { closer, calls } = create_recording_closer();
			const audit_events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				audit_factory: (params) =>
					create_audit_emitter({ ...params, on_audit_event: (e) => audit_events.push(e) })
			});
			const target = await test_app.create_account({ username: 'crossaccttoken' });
			// Create a token on the target account so we have a real id to probe.
			const create_res = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: 'account_token_create',
				params: { name: 'target_owned', scope: { kind: 'full' }, lifetime: { kind: 'eternal' } },
				headers: target.create_session_headers()
			});
			assert.strictEqual(create_res.ok, true);
			const created = create_res.ok ? (create_res.result as { id: string }) : { id: '' };
			const target_token_id = created.id;
			calls.length = 0;

			// First account attempts to revoke the target's token.
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_token_revoke_action_spec,
				params: { token_id: target_token_id as never },
				headers: test_app.create_session_headers()
			});
			assert.strictEqual(res.ok, true);
			if (res.ok) assert.strictEqual(res.result.revoked, false);
			assert.strictEqual(calls.length, 0, 'closer must NOT fire on cross-account token revoke');

			// Target's token is still listed — IDOR didn't bypass the guard.
			const target_list = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: 'account_token_list',
				headers: target.create_session_headers()
			});
			assert.strictEqual(target_list.ok, true);
			const target_listed = target_list.ok
				? (target_list.result as { tokens: Array<{ id: string }> })
				: { tokens: [] };
			assert.ok(
				target_listed.tokens.some((t) => t.id === target_token_id),
				'target token still present after cross-account revoke attempt'
			);

			const failure_audits = audit_events.filter(
				(e) => e.event_type === 'token_revoke' && e.outcome === 'failure'
			);
			assert.strictEqual(failure_audits.length, 1);
			const meta = failure_audits[0]!.metadata as { token_id?: string };
			assert.strictEqual(meta.token_id, target_token_id);
			assert.strictEqual(
				failure_audits[0]!.account_id,
				test_app.backend.account.id,
				'audit pins the calling account, not the target'
			);
			await test_app.cleanup();
		});
	});

	describe('admin_actions (revoke-all)', () => {
		test('admin_session_revoke_all closes the target account', async () => {
			const { closer, calls } = create_recording_closer();
			const audit_events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				roles: [ROLE_KEEPER, ROLE_ADMIN],
				audit_factory: (params) =>
					create_audit_emitter({ ...params, on_audit_event: (e) => audit_events.push(e) })
			});
			// Create a second account to revoke against
			const target = await test_app.create_account({ username: 'closertarget' });
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: admin_session_revoke_all_action_spec,
				params: { account_id: target.account.id },
				headers: test_app.create_session_headers()
			});
			assert.strictEqual(res.ok, true);
			assert.strictEqual(calls.length, 1);
			// The audit success-shape assertions below pin the row's
			// `target_account_id` + `metadata.count` so a refactor that dropped
			// either would surface.
			assert_close_call(calls[0], 'account', target.account.id);
			const success_audits = audit_events.filter(
				(e) => e.event_type === 'session_revoke_all' && e.outcome === 'success'
			);
			assert.strictEqual(success_audits.length, 1);
			assert.strictEqual(success_audits[0]!.target_account_id, target.account.id);
			const success_meta = success_audits[0]!.metadata as { count?: number };
			assert.strictEqual(typeof success_meta.count, 'number');
			await test_app.cleanup();
		});

		test('admin_token_revoke_all closes the target account', async () => {
			const { closer, calls } = create_recording_closer();
			const audit_events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				roles: [ROLE_KEEPER, ROLE_ADMIN],
				audit_factory: (params) =>
					create_audit_emitter({ ...params, on_audit_event: (e) => audit_events.push(e) })
			});
			const target = await test_app.create_account({ username: 'closertarget2' });
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: admin_token_revoke_all_action_spec,
				params: { account_id: target.account.id },
				headers: test_app.create_session_headers()
			});
			assert.strictEqual(res.ok, true);
			assert.strictEqual(calls.length, 1);
			assert_close_call(calls[0], 'account', target.account.id);
			// Mirror the session-revoke-all success-shape assertions above —
			// pin `target_account_id` populated and `metadata.count` set.
			const success_audits = audit_events.filter(
				(e) => e.event_type === 'token_revoke_all' && e.outcome === 'success'
			);
			assert.strictEqual(success_audits.length, 1);
			assert.strictEqual(success_audits[0]!.target_account_id, target.account.id);
			const success_meta = success_audits[0]!.metadata as {
				count?: number;
				credential_type?: string;
			};
			assert.strictEqual(typeof success_meta.count, 'number');
			// Pin the asymmetry vs `session_revoke_all`: the `token_revoke_all`
			// schema in `audit_log_schema.ts` deliberately omits `credential_type`
			// because only the admin handler emits this event_type (no self-
			// service counterpart), and admin handlers don't carry credential_type
			// in metadata. A copy-paste refactor that added the field to the
			// emit site (mirroring `session_revoke_all`) would also need to widen
			// the schema, and this assertion catches the half-applied refactor.
			assert.strictEqual(
				'credential_type' in success_meta,
				false,
				'admin token_revoke_all does not carry credential_type by design'
			);
			await test_app.cleanup();
		});

		test('admin_session_revoke_all does NOT close on account-not-found 404', async () => {
			const { closer, calls } = create_recording_closer();
			const audit_events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				roles: [ROLE_KEEPER, ROLE_ADMIN],
				audit_factory: (params) =>
					create_audit_emitter({ ...params, on_audit_event: (e) => audit_events.push(e) })
			});
			const bogus_id = '00000000-0000-0000-0000-000000000000';
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: admin_session_revoke_all_action_spec,
				params: { account_id: bogus_id as never },
				headers: test_app.create_session_headers()
			});
			assert.strictEqual(res.ok, false);
			assert.strictEqual(res.status, 404);
			assert.strictEqual(
				calls.length,
				0,
				'closer must not fire on the not-found path — closes attacker-guessable ids otherwise'
			);
			// Forensics shape per `admin_actions.ts::session_revoke_all_handler`:
			// `target_account_id` is null (FK forces it) and the probed id is
			// preserved under `metadata.attempted_account_id`. Pins the
			// documented contract so a refactor that drops the metadata write
			// (or accidentally writes the bogus id into the FK column) trips here.
			const failure_audits = audit_events.filter(
				(e) => e.event_type === 'session_revoke_all' && e.outcome === 'failure'
			);
			assert.strictEqual(failure_audits.length, 1);
			assert.strictEqual(failure_audits[0]!.target_account_id, null);
			const meta = failure_audits[0]!.metadata as {
				reason?: string;
				attempted_account_id?: string;
			};
			assert.strictEqual(meta.attempted_account_id, bogus_id);
			assert.strictEqual(meta.reason, ERROR_ACCOUNT_NOT_FOUND);
			await test_app.cleanup();
		});

		test('admin_token_revoke_all does NOT close on account-not-found 404', async () => {
			// Symmetric to the `admin_session_revoke_all` not-found test above.
			// Both handlers in `admin_actions.ts` share the same shape — pre-revoke
			// account-existence check, failure audit with null `target_account_id`,
			// `attempted_account_id` metadata, then throw — so a regression on
			// one would slip past the other's test without this companion case.
			const { closer, calls } = create_recording_closer();
			const audit_events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				roles: [ROLE_KEEPER, ROLE_ADMIN],
				audit_factory: (params) =>
					create_audit_emitter({ ...params, on_audit_event: (e) => audit_events.push(e) })
			});
			const bogus_id = '00000000-0000-0000-0000-000000000000';
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: admin_token_revoke_all_action_spec,
				params: { account_id: bogus_id as never },
				headers: test_app.create_session_headers()
			});
			assert.strictEqual(res.ok, false);
			assert.strictEqual(res.status, 404);
			assert.strictEqual(calls.length, 0);
			const failure_audits = audit_events.filter(
				(e) => e.event_type === 'token_revoke_all' && e.outcome === 'failure'
			);
			assert.strictEqual(failure_audits.length, 1);
			assert.strictEqual(failure_audits[0]!.target_account_id, null);
			const meta = failure_audits[0]!.metadata as {
				reason?: string;
				attempted_account_id?: string;
			};
			assert.strictEqual(meta.attempted_account_id, bogus_id);
			assert.strictEqual(meta.reason, ERROR_ACCOUNT_NOT_FOUND);
			await test_app.cleanup();
		});

		test('admin_session_revoke_all closes the target account when count is zero', async () => {
			// Pins the close-fires-when-count-zero contract: a target account
			// that exists but has no active sessions still triggers the
			// close. The handler returns count: 0 and the closer records a single
			// account-wide call. Without this test, a refactor that gated the
			// close on `if (count > 0)` (a plausible micro-optimization) would
			// pass every other admin test in this file (each of which seeds at
			// least one session via the higher-level `create_account` helper).
			const { closer, calls } = create_recording_closer();
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				roles: [ROLE_KEEPER, ROLE_ADMIN]
			});
			// Bare DB account — no session, no token, no role_grant.
			const target = await create_test_account_with_actor(get_db(), {
				username: 'nolivesessions'
			});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: admin_session_revoke_all_action_spec,
				params: { account_id: target.account.id },
				headers: test_app.create_session_headers()
			});
			assert.strictEqual(res.ok, true);
			if (res.ok) assert.strictEqual(res.result.count, 0);
			assert.strictEqual(calls.length, 1, 'close fires unconditionally on the success path');
			assert_close_call(calls[0], 'account', target.account.id);
			await test_app.cleanup();
		});

		test('admin_token_revoke_all closes the target account when count is zero', async () => {
			// Symmetric to the `admin_session_revoke_all` zero-count test above.
			const { closer, calls } = create_recording_closer();
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				roles: [ROLE_KEEPER, ROLE_ADMIN]
			});
			const target = await create_test_account_with_actor(get_db(), {
				username: 'nolivetokens'
			});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: admin_token_revoke_all_action_spec,
				params: { account_id: target.account.id },
				headers: test_app.create_session_headers()
			});
			assert.strictEqual(res.ok, true);
			if (res.ok) assert.strictEqual(res.result.count, 0);
			assert.strictEqual(calls.length, 1);
			assert_close_call(calls[0], 'account', target.account.id);
			await test_app.cleanup();
		});
	});

	describe('REST routes (logout / password)', () => {
		test('logout closes the account sockets (account-wide, matching Rust)', async () => {
			const { closer, calls } = create_recording_closer();
			const audit_events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				audit_factory: (params) =>
					create_audit_emitter({ ...params, on_audit_event: (e) => audit_events.push(e) })
			});
			const logout_route = find_auth_route(test_app.route_specs, '/logout', 'POST');
			assert.ok(logout_route, 'logout route registered');
			const res = await test_app.app.request(logout_route.path, {
				method: 'POST',
				headers: test_app.create_session_headers(),
				body: null
			});
			assert.strictEqual(res.status, 200);
			assert.strictEqual(calls.length, 1, 'closer fired once');
			// The close is ACCOUNT-WIDE — matches the Rust `account_logout`
			// handler and the sibling `/password` handler. Only the current
			// session ROW is deleted (token-hash-scoped), but the close is
			// account-grain — the scope `logout` declares in
			// `audit_event_revocation_scopes`, so the handler's close and the
			// audit listeners' converge.
			assert_close_call(calls[0], 'account', test_app.backend.account.id);
			// Pin `event_type: 'logout'` (NOT `session_revoke`) on the audit row.
			// The listeners close by the scope the event type declares: a refactor
			// that emitted `session_revoke` here would narrow the listener close
			// to one session, and mislabel the row for admin forensics.
			const logout_audits = audit_events.filter((e) => e.event_type === 'logout');
			assert.strictEqual(logout_audits.length, 1, 'logout emits exactly one logout audit row');
			const stray_session_revoke = audit_events.filter((e) => e.event_type === 'session_revoke');
			assert.strictEqual(
				stray_session_revoke.length,
				0,
				'logout must NOT emit a session_revoke event — see audit_event_revocation_scopes'
			);
			await test_app.cleanup();
		});

		test('password change closes all account sockets', async () => {
			const { closer, calls } = create_recording_closer();
			const audit_events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				audit_factory: (params) =>
					create_audit_emitter({ ...params, on_audit_event: (e) => audit_events.push(e) })
			});
			const password_route = find_auth_route(test_app.route_specs, '/password', 'POST');
			assert.ok(password_route, 'password route registered');
			const res = await test_app.app.request(password_route.path, {
				method: 'POST',
				headers: {
					...test_app.create_session_headers(),
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					current_password: DEFAULT_TEST_PASSWORD,
					new_password: 'new-test-password-xyz'
				})
			});
			assert.strictEqual(res.status, 200);
			assert.strictEqual(calls.length, 1, 'closer fired once for the account-wide revoke');
			assert_close_call(calls[0], 'account', test_app.backend.account.id);
			// Pin the defense-in-depth `credential_type` field on the
			// success-path audit metadata (see `docs/security.md`
			// §Credential-channel gating). A refactor that drops the field
			// from `account_routes.ts::password` would silently break
			// forensic visibility into which credential channel performed
			// the password change.
			const success_audits = audit_events.filter(
				(e) => e.event_type === 'password_change' && e.outcome === 'success'
			);
			assert.strictEqual(success_audits.length, 1);
			const meta = success_audits[0]!.metadata as {
				credential_type?: string;
				sessions_revoked?: number;
				tokens_revoked?: number;
			};
			assert.strictEqual(meta.credential_type, 'session');
			// Pin the cascade counts on the audit row — the API response
			// already carries them in the handler return, but the audit log is
			// the forensic record. A regression that dropped either field from
			// the success-path metadata would silently lose visibility into
			// the revoke-all cascade scale at audit-review time (the API
			// surface assertion lives separately in password_change.test.ts).
			assert.strictEqual(typeof meta.sessions_revoked, 'number');
			assert.strictEqual(typeof meta.tokens_revoked, 'number');
			// Bootstrap session is the only revocation target on a fresh
			// test_app — pin the exact value so a regression that double-
			// counted or short-circuited the revoke trips here.
			assert.strictEqual(meta.sessions_revoked, 1);
			assert.strictEqual(meta.tokens_revoked, 1, 'bootstrap also mints an api_token');
			await test_app.cleanup();
		});

		test('logout rejects a bearer-only caller (no session) → 403 credential_type_required', async () => {
			// Logout is session-gated (`credential_types: ['session']`, see
			// docs/security.md §Credential-channel gating): a bearer / daemon
			// token holds no session to end, so the dispatcher refuses it before
			// the handler runs — no socket close, no phantom `logout` audit row,
			// no misleading 200. Pins that the closer never fires on a credential
			// the gate rejects (it can't reach the close path at all).
			const { closer, calls } = create_recording_closer();
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db()
			});
			const logout_route = find_auth_route(test_app.route_specs, '/logout', 'POST');
			assert.ok(logout_route, 'logout route registered');
			const res = await test_app.app.request(logout_route.path, {
				method: 'POST',
				headers: test_app.create_bearer_headers(),
				body: null
			});
			assert.strictEqual(res.status, 403);
			const body = (await res.json()) as {
				error?: string;
				required_credential_types?: Array<string>;
			};
			assert.strictEqual(body.error, ERROR_CREDENTIAL_TYPE_REQUIRED);
			assert.deepStrictEqual(body.required_credential_types, ['session']);
			assert.strictEqual(
				calls.length,
				0,
				'closer must not fire when the credential gate refuses the caller'
			);
			await test_app.cleanup();
		});

		test('password change does NOT close on wrong-password 401', async () => {
			const { closer, calls } = create_recording_closer();
			const audit_events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				audit_factory: (params) =>
					create_audit_emitter({ ...params, on_audit_event: (e) => audit_events.push(e) })
			});
			const password_route = find_auth_route(test_app.route_specs, '/password', 'POST');
			assert.ok(password_route, 'password route registered');
			const res = await test_app.app.request(password_route.path, {
				method: 'POST',
				headers: {
					...test_app.create_session_headers(),
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					current_password: 'wrong-password-xx',
					new_password: 'new-test-password-xyz'
				})
			});
			assert.strictEqual(res.status, 401);
			assert.strictEqual(calls.length, 0, 'closer must not fire on wrong-password failure');
			// Pin the failure audit so a regression that dropped both the
			// close AND the failure audit would surface here. `credential_type`
			// is the defense-in-depth field from `docs/security.md` §Credential-
			// channel gating — present on every outcome of `password_change`.
			const failure_audits = audit_events.filter(
				(e) => e.event_type === 'password_change' && e.outcome === 'failure'
			);
			assert.strictEqual(failure_audits.length, 1);
			const meta = failure_audits[0]!.metadata as { credential_type?: string };
			assert.strictEqual(meta.credential_type, 'session');
			await test_app.cleanup();
		});
	});

	describe('standard_rpc_actions bundle closes through deps.connection_closer', () => {
		// The per-factory tests above exercise `create_account_actions` and
		// `create_admin_actions` directly. The `create_standard_rpc_actions`
		// bundle hands its `deps` to all three sub-factories — admin + account
		// read `connection_closer` off it, role-grant-offer ignores it. A
		// refactor to per-sub-factory dep picks that forgot to thread
		// `connection_closer` would silently disable the closes for consumers
		// using the bundle. Two assertions — one account-side, one admin-side —
		// guard against asymmetric regressions where only one of the two
		// sub-factory threads breaks.
		test('account + admin handlers both fire the closer when wired via the bundle', async () => {
			const { closer, calls } = create_recording_closer();
			const test_app = await create_test_app({
				session_options,
				create_route_specs: (ctx: AppServerContext): Array<RouteSpec> => {
					ctx.deps.connection_closer.add(closer);
					return [
						...prefix_route_specs(
							'/api/account',
							create_account_route_specs(ctx.deps, {
								session_options,
								login_ip_rate_limiter: ctx.login_ip_rate_limiter,
								login_account_rate_limiter: ctx.login_account_rate_limiter,
								login_fail_floor_ms: 0
							})
						),
						...create_rpc_endpoint({
							path: RPC_PATH,
							actions: create_standard_rpc_actions(ctx.deps),
							log: ctx.deps.log
						})
					];
				},
				db: get_db(),
				roles: [ROLE_KEEPER, ROLE_ADMIN]
			});

			// admin-side first — exercises the admin sub-factory's option
			// thread. Run before the account-side revoke because the latter
			// kills the bootstrap session this admin call authenticates with.
			// Catches the asymmetric regression where the admin sub-factory
			// drops `connection_closer` while the account side keeps it.
			const target = await test_app.create_account({ username: 'bundleadmintarget' });
			const admin_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: admin_session_revoke_all_action_spec,
				params: { account_id: target.account.id },
				headers: test_app.create_session_headers()
			});
			assert.strictEqual(admin_res.ok, true);
			assert.strictEqual(
				calls.length,
				1,
				'standard bundle wired closer into admin_session_revoke_all'
			);
			assert_close_call(calls[0], 'account', target.account.id);

			// account-side: discover the bootstrap session id, then revoke
			// it. Sits after the admin call because revoking the bootstrap
			// session invalidates `create_session_headers()` for any
			// subsequent admin call.
			calls.length = 0;
			const list_res = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: 'account_session_list',
				headers: test_app.create_session_headers()
			});
			assert.strictEqual(list_res.ok, true);
			const listed = list_res.ok
				? (list_res.result as { sessions: Array<{ id: string }> })
				: { sessions: [] };
			const session_id = listed.sessions[0]!.id;

			const account_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_session_revoke_action_spec,
				params: { session_id: session_id as never },
				headers: test_app.create_session_headers()
			});
			assert.strictEqual(account_res.ok, true);
			assert.strictEqual(
				calls.length,
				1,
				'standard bundle wired closer into account_session_revoke'
			);
			assert_close_call(calls[0], 'session', session_id);

			await test_app.cleanup();
		});
	});

	describe('every revocation site', () => {
		// Each site is driven four ways against one harness: the close lands
		// after the commit, a thrown handler closes nothing, a failed audit
		// write still closes, and the close reaches a real socket and a real
		// stream (asserted inside the first and third).

		/** One close, as its `ConnectionCloser` call saw the world. */
		interface ProbedClose {
			method: 'session' | 'token' | 'account';
			id: string;
			/** Transactions open on the request's `Db` when the close was called. */
			open_transactions: number;
			/** Whether a pool read, issued when the close was called, saw the revocation. */
			committed: Promise<boolean>;
		}

		/** A live connection of one identity, on both transports. */
		interface LiveConnection {
			ws: FakeWs;
			stream: SseStream<SseNotification> & { closed: boolean };
		}

		interface SiteHarness {
			test_app: TestApp;
			/** The raw pool — a read here is outside every request transaction. */
			db: Db;
			/** The gate the backend's `Db` runs through — its stall holds a pool write. */
			gated: GatedDb;
			closes: Array<ProbedClose>;
			/** Open a connection of `identity` on the real transport and the real audit stream registry. */
			connect: (identity: {
				account_id: Uuid;
				session_token_hash?: string;
				api_token_id?: string;
			}) => LiveConnection;
			/** Failure injection, off until a test flips it. */
			failing: {
				/** The handler's next success `audit.emit` throws — the handler fails after its revoke. */
				emit: boolean;
				/** The audit INSERT rejects — the fail-open audit write is lost. */
				audit_write: boolean;
			};
			/** What "the revocation committed" means for the site under test. */
			committed: { read: ((db: Db) => Promise<boolean>) | null };
		}

		const create_mock_stream = (): SseStream<SseNotification> & { closed: boolean } => {
			let closed = false;
			return {
				get closed() {
					return closed;
				},
				send() {},
				comment() {},
				close() {
					closed = true;
				},
				on_close() {}
			};
		};

		const create_site_harness = async (
			db: Db,
			options: { max_sessions?: number; max_tokens?: number } = {}
		): Promise<SiteHarness> => {
			const gated: GatedDb = create_gated_db(db);
			const closes: Array<ProbedClose> = [];
			const failing = { emit: false, audit_write: false };
			const committed: SiteHarness['committed'] = { read: null };
			const record = (method: ProbedClose['method'], id: string): number => {
				closes.push({
					method,
					id,
					open_transactions: gated.open_transactions(),
					committed: committed.read ? committed.read(db) : Promise.resolve(false)
				});
				return 0;
			};
			const probe: ConnectionCloser = {
				close_sockets_for_session: (id) => record('session', id),
				close_sockets_for_token: (id) => record('token', id),
				close_sockets_for_account: (id) => record('account', id)
			};
			const transport = new BackendWebsocketTransport({ log });
			let audit_sse: AuditLogSse | null = null;
			const test_app = await create_test_app({
				session_options,
				db: gated.db,
				roles: [ROLE_KEEPER, ROLE_ADMIN],
				// `create_app_server` adds the audit stream registry to the
				// backend's closer; the transport is added by hand below, the way
				// a `ws_endpoints` mount adds its own
				app_options: { audit_log_sse: true },
				create_route_specs: (ctx) => {
					audit_sse = ctx.audit_sse;
					ctx.deps.connection_closer.add(transport);
					return make_create_route_specs(probe, options)(ctx);
				},
				audit_factory: ({ db: pool, log: audit_log }) =>
					create_audit_emitter({
						// the emitter's own pool handle, so its INSERT can be failed
						// without touching the handlers' queries
						db: new Db({
							client: {
								query: (text, values) =>
									failing.audit_write && text.includes('INSERT INTO audit_log')
										? Promise.reject(new Error('audit write failed'))
										: pool.client.query(text, values)
							},
							transaction: (fn) => pool.transaction(fn)
						}),
						log: audit_log,
						emit_decorator: (inner) => (ctx, input) => {
							if (failing.emit && input.outcome !== 'failure') {
								throw new Error('injected handler failure');
							}
							inner(ctx, input);
						}
					})
			});
			assert.ok(audit_sse);
			const sse: AuditLogSse = audit_sse;
			return {
				test_app,
				db,
				gated,
				closes,
				failing,
				committed,
				connect: (identity) => {
					const ws = create_fake_ws();
					transport.add_connection(
						ws.ws,
						identity.session_token_hash ?? null,
						identity.account_id,
						identity.api_token_id ?? null
					);
					const stream = create_mock_stream();
					sse.registry.subscribe(stream, {
						scope: identity.session_token_hash,
						groups: identity.api_token_id
							? [identity.account_id, identity.api_token_id]
							: [identity.account_id]
					});
					return { ws, stream };
				}
			};
		};

		const exists = async (db: Db, sql: string, params: Array<unknown>): Promise<boolean> =>
			(await db.query(sql, params)).length > 0;

		const session_ids = async (h: SiteHarness): Promise<Array<string>> => {
			const res = await rpc_call({
				app: h.test_app.app,
				path: RPC_PATH,
				method: 'account_session_list',
				headers: h.test_app.create_session_headers()
			});
			assert.strictEqual(res.ok, true);
			return res.ok
				? (res.result as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id)
				: [];
		};

		const token_ids = async (h: SiteHarness): Promise<Array<string>> => {
			const res = await rpc_call({
				app: h.test_app.app,
				path: RPC_PATH,
				method: 'account_token_list',
				headers: h.test_app.create_session_headers()
			});
			assert.strictEqual(res.ok, true);
			return res.ok
				? (res.result as { tokens: Array<{ id: string }> }).tokens.map((t) => t.id)
				: [];
		};

		const rpc = async (h: SiteHarness, method: string, params?: unknown): Promise<boolean> =>
			(
				await rpc_call({
					app: h.test_app.app,
					path: RPC_PATH,
					method,
					params,
					headers: h.test_app.create_session_headers()
				})
			).ok;

		/** What one site revokes and how to drive it. */
		interface Arranged {
			/** The connection identity the revocation must close. */
			victim: { account_id: Uuid; session_token_hash?: string; api_token_id?: string };
			expected: { method: ProbedClose['method']; id: string };
			/** True once the revocation is visible to a read through the pool. */
			committed: (db: Db) => Promise<boolean>;
			/** Make the revoking request; resolves whether it succeeded. */
			act: () => Promise<boolean>;
		}

		interface Site {
			name: string;
			max_sessions?: number;
			max_tokens?: number;
			arrange: (h: SiteHarness) => Promise<Arranged>;
		}

		const keeper_id = (h: SiteHarness): Uuid => h.test_app.backend.account.id;

		const no_sessions = (db: Db, account_id: Uuid): Promise<boolean> =>
			exists(db, 'SELECT 1 FROM auth_session WHERE account_id = $1', [account_id]).then((v) => !v);

		const no_tokens = (db: Db, account_id: Uuid): Promise<boolean> =>
			exists(db, 'SELECT 1 FROM api_token WHERE account_id = $1', [account_id]).then((v) => !v);

		const sites: Array<Site> = [
			{
				name: 'account_session_revoke',
				arrange: async (h) => {
					const [session_id] = await session_ids(h);
					assert.ok(session_id);
					return {
						victim: { account_id: keeper_id(h), session_token_hash: session_id },
						expected: { method: 'session', id: session_id },
						committed: async (db) =>
							!(await exists(db, 'SELECT 1 FROM auth_session WHERE id = $1', [session_id])),
						act: () => rpc(h, 'account_session_revoke', { session_id })
					};
				}
			},
			{
				name: 'account_session_revoke_all',
				arrange: async (h) => {
					const [session_id] = await session_ids(h);
					return {
						victim: { account_id: keeper_id(h), session_token_hash: session_id },
						expected: { method: 'account', id: keeper_id(h) },
						committed: (db) => no_sessions(db, keeper_id(h)),
						act: () => rpc(h, 'account_session_revoke_all')
					};
				}
			},
			{
				name: 'account_token_revoke',
				arrange: async (h) => {
					const [token_id] = await token_ids(h);
					assert.ok(token_id);
					return {
						victim: { account_id: keeper_id(h), api_token_id: token_id },
						expected: { method: 'token', id: token_id },
						committed: async (db) =>
							!(await exists(db, 'SELECT 1 FROM api_token WHERE id = $1', [token_id])),
						act: () => rpc(h, 'account_token_revoke', { token_id })
					};
				}
			},
			{
				// the token cap: minting one past it evicts the oldest, whose
				// connections must end with it
				name: 'account_token_create (cap eviction)',
				max_tokens: 1,
				arrange: async (h) => {
					const [evicted_id] = await token_ids(h);
					assert.ok(evicted_id);
					return {
						victim: { account_id: keeper_id(h), api_token_id: evicted_id },
						expected: { method: 'token', id: evicted_id },
						committed: async (db) =>
							!(await exists(db, 'SELECT 1 FROM api_token WHERE id = $1', [evicted_id])),
						act: () =>
							rpc(h, 'account_token_create', {
								name: 'one past the cap',
								scope: { kind: 'full' },
								lifetime: { kind: 'eternal' }
							})
					};
				}
			},
			{
				name: 'admin_session_revoke_all',
				arrange: async (h) => {
					const target = await h.test_app.create_account({ username: 'site_target' });
					return {
						victim: { account_id: target.account.id, session_token_hash: 'target-session-hash' },
						expected: { method: 'account', id: target.account.id },
						committed: (db) => no_sessions(db, target.account.id),
						act: () => rpc(h, 'admin_session_revoke_all', { account_id: target.account.id })
					};
				}
			},
			{
				name: 'admin_token_revoke_all',
				arrange: async (h) => {
					const target = await h.test_app.create_account({ username: 'site_target' });
					return {
						victim: { account_id: target.account.id, api_token_id: 'tok_targettarget' },
						expected: { method: 'account', id: target.account.id },
						committed: (db) => no_tokens(db, target.account.id),
						act: () => rpc(h, 'admin_token_revoke_all', { account_id: target.account.id })
					};
				}
			},
			{
				name: 'account_delete',
				arrange: async (h) => {
					const target = await h.test_app.create_account({ username: 'site_target' });
					return {
						victim: { account_id: target.account.id, session_token_hash: 'target-session-hash' },
						expected: { method: 'account', id: target.account.id },
						committed: (db) =>
							exists(db, 'SELECT 1 FROM account WHERE id = $1 AND deleted_at IS NOT NULL', [
								target.account.id
							]),
						act: () => rpc(h, 'account_delete', { account_id: target.account.id })
					};
				}
			},
			{
				name: 'account_purge',
				arrange: async (h) => {
					const target = await h.test_app.create_account({ username: 'site_target' });
					return {
						victim: { account_id: target.account.id, session_token_hash: 'target-session-hash' },
						expected: { method: 'account', id: target.account.id },
						committed: async (db) =>
							!(await exists(db, 'SELECT 1 FROM account WHERE id = $1', [target.account.id])),
						// purge is gated to the daemon-token credential, which the
						// middleware discards beside an `Origin` header
						act: async () =>
							(
								await rpc_call({
									app: h.test_app.app,
									path: RPC_PATH,
									method: 'account_purge',
									params: { account_id: target.account.id, confirm: true },
									suppress_default_origin: true,
									headers: h.test_app.create_daemon_token_headers()
								})
							).ok
					};
				}
			},
			{
				name: 'POST /logout',
				arrange: async (h) => {
					const [session_id] = await session_ids(h);
					assert.ok(session_id);
					return {
						victim: { account_id: keeper_id(h), session_token_hash: session_id },
						expected: { method: 'account', id: keeper_id(h) },
						committed: async (db) =>
							!(await exists(db, 'SELECT 1 FROM auth_session WHERE id = $1', [session_id])),
						act: async () =>
							(
								await h.test_app.app.request('/api/account/logout', {
									method: 'POST',
									headers: h.test_app.create_session_headers(),
									body: null
								})
							).ok
					};
				}
			},
			{
				name: 'POST /password',
				arrange: async (h) => {
					const [session_id] = await session_ids(h);
					return {
						victim: { account_id: keeper_id(h), session_token_hash: session_id },
						expected: { method: 'account', id: keeper_id(h) },
						committed: async (db) =>
							(await no_sessions(db, keeper_id(h))) && (await no_tokens(db, keeper_id(h))),
						act: async () =>
							(
								await h.test_app.app.request('/api/account/password', {
									method: 'POST',
									headers: {
										...h.test_app.create_session_headers(),
										'Content-Type': 'application/json'
									},
									body: JSON.stringify({
										current_password: DEFAULT_TEST_PASSWORD,
										new_password: 'new-test-password-xyz'
									})
								})
							).ok
					};
				}
			},
			{
				// the session cap: a login past it evicts the oldest session, whose
				// connections must end with it
				name: 'POST /login (cap eviction)',
				max_sessions: 1,
				arrange: async (h) => {
					const [evicted_hash] = await session_ids(h);
					assert.ok(evicted_hash);
					return {
						victim: { account_id: keeper_id(h), session_token_hash: evicted_hash },
						expected: { method: 'session', id: evicted_hash },
						committed: async (db) =>
							!(await exists(db, 'SELECT 1 FROM auth_session WHERE id = $1', [evicted_hash])),
						act: async () =>
							(
								await h.test_app.app.request('/api/account/login', {
									method: 'POST',
									headers: {
										host: 'localhost',
										origin: 'http://localhost:5173',
										'Content-Type': 'application/json'
									},
									body: JSON.stringify({ username: 'keeper', password: DEFAULT_TEST_PASSWORD })
								})
							).ok
					};
				}
			}
		];

		/** Arrange a site and open its victim, a sibling under another credential, and a bystander. */
		const arrange_site = async (
			site: Site,
			db: Db
		): Promise<{
			h: SiteHarness;
			arranged: Arranged;
			victim: LiveConnection;
			sibling: LiveConnection;
			bystander: LiveConnection;
		}> => {
			const h = await create_site_harness(db, site);
			const arranged = await site.arrange(h);
			h.committed.read = arranged.committed;
			const bystander_account = await h.test_app.create_account({ username: 'site_bystander' });
			return {
				h,
				arranged,
				victim: h.connect(arranged.victim),
				// same account, a credential the site does not name
				sibling: h.connect({
					account_id: arranged.victim.account_id,
					session_token_hash: 'sibling-session-hash'
				}),
				bystander: h.connect({
					account_id: bystander_account.account.id,
					session_token_hash: 'bystander-session-hash'
				})
			};
		};

		const assert_closed = (connection: LiveConnection, label: string): void => {
			assert.deepStrictEqual(
				connection.ws.closes,
				[{ code: WS_CLOSE_SESSION_REVOKED, reason: WS_CLOSE_SESSION_REVOKED_REASON }],
				`${label}: the socket closed with the revocation code`
			);
			assert.ok(connection.stream.closed, `${label}: the stream closed`);
		};

		const assert_open = (connection: LiveConnection, label: string): void => {
			assert.deepStrictEqual(connection.ws.closes, [], `${label}: the socket stays open`);
			assert.ok(!connection.stream.closed, `${label}: the stream stays open`);
		};

		/** The close the site made, the connections it ended, and the ones it left. */
		const assert_site_closed = (
			arranged: Arranged,
			closes: Array<ProbedClose>,
			connections: { victim: LiveConnection; sibling: LiveConnection; bystander: LiveConnection }
		): void => {
			assert.strictEqual(closes.length, 1, 'exactly one close');
			assert_close_call(closes[0], arranged.expected.method, arranged.expected.id);
			assert_closed(connections.victim, 'victim');
			// an account-wide close takes the sibling with it; a session- or
			// token-scoped one must not
			if (arranged.expected.method === 'account') assert_closed(connections.sibling, 'sibling');
			else assert_open(connections.sibling, 'sibling');
			assert_open(connections.bystander, 'bystander');
		};

		for (const site of sites) {
			describe(site.name, () => {
				test('closes after its transaction commits', async () => {
					const { h, arranged, ...connections } = await arrange_site(site, get_db());

					assert.strictEqual(await arranged.act(), true);

					assert_site_closed(arranged, h.closes, connections);
					const close = h.closes[0]!;
					assert.strictEqual(
						close.open_transactions,
						0,
						'the close ran with no transaction open — after the commit'
					);
					assert.strictEqual(
						await close.committed,
						true,
						'a pool read made when the close ran saw the revocation'
					);
					await h.test_app.cleanup();
				});

				test('a handler that throws closes nothing', async () => {
					const { h, arranged, ...connections } = await arrange_site(site, get_db());

					h.failing.emit = true;
					assert.strictEqual(await arranged.act(), false, 'the request failed');
					h.failing.emit = false;

					assert.deepStrictEqual(h.closes, [], 'no close for a revocation that rolled back');
					assert.strictEqual(await arranged.committed(h.db), false, 'and nothing was revoked');
					assert_open(connections.victim, 'victim');
					assert_open(connections.sibling, 'sibling');
					assert_open(connections.bystander, 'bystander');
					await h.test_app.cleanup();
				});

				test('a failed audit write still closes', async () => {
					const { h, arranged, ...connections } = await arrange_site(site, get_db());

					h.failing.audit_write = true;
					assert.strictEqual(await arranged.act(), true, 'the audit write is fail-open');
					h.failing.audit_write = false;

					assert.strictEqual(await arranged.committed(h.db), true);
					// no audit row was written, so no listener ran: the handler's own
					// close is what ended the connections
					assert_site_closed(arranged, h.closes, connections);
					await h.test_app.cleanup();
				});
			});
		}

		describe('the close does not wait for the audit write', () => {
			// The audit INSERT is eager and pool-routed, so it can still be in
			// flight when the revocation's transaction has committed. A close
			// flushed behind it would leave the connection open on a credential
			// already gone for as long as the write takes. Each case holds the
			// INSERT and requires the close while it is held.

			test('over HTTP, the close has run while the audit INSERT is held', async () => {
				const h = await create_site_harness(get_db());
				const account_id = keeper_id(h);
				const victim = h.connect({ account_id, session_token_hash: 'held-write-victim' });

				const stalled = h.gated.stall(is_audit_insert);
				const request = rpc(h, 'account_session_revoke_all');
				await stalled.reached;
				try {
					await until(() => h.closes.length > 0, 'no close while the audit write was held');
					assert.strictEqual(h.closes.length, 1);
					assert_close_call(h.closes[0], 'account', account_id);
					assert.strictEqual(h.closes[0]!.open_transactions, 0, 'after the commit');
					assert.strictEqual(await no_sessions(h.db, account_id), true, 'the revoke committed');
					assert_closed(victim, 'victim');
				} finally {
					stalled.release();
				}
				assert.strictEqual(await request, true);
				await h.test_app.cleanup();
			});

			test('over WebSocket, a self-revoking socket is closed while the audit INSERT is held', async () => {
				const h = await create_site_harness(get_db());
				const { deps } = h.test_app.backend;
				const account_id = keeper_id(h);
				const [session_token_hash] = await session_ids(h);
				assert.ok(session_token_hash);

				// the account actions over a real dispatcher, on the keeper's session
				const stub = create_stub_upgrade();
				register_action_ws({
					path: '/ws',
					app: new Hono(),
					upgradeWebSocket: stub.upgradeWebSocket,
					actions: create_account_actions(deps),
					db: deps.db,
					connection_closer: deps.connection_closer,
					heartbeat: false,
					log
				});
				const request_context = await build_account_context({ db: h.db }, account_id);
				assert.ok(request_context);
				// what the auth middleware leaves on the context for the upgrade
				const vars: Record<string, unknown> = {
					[ACCOUNT_ID_KEY]: account_id,
					[CREDENTIAL_TYPE_KEY]: 'session',
					[AUTH_SESSION_TOKEN_HASH_KEY]: session_token_hash,
					[REQUEST_CONTEXT_KEY]: request_context
				};
				const events = await stub.get_create_events()({
					get: (key: string) => vars[key]
				} as unknown as Context);
				const socket = create_fake_ws();
				// typed `void` by Hono, but `register_action_ws` returns the admission's promise
				await (events.onOpen?.(new Event('open'), socket.ws) as Promise<void> | void);
				assert.deepStrictEqual(socket.closes, [], 'admitted');
				const { onMessage } = events;
				assert.ok(onMessage);
				const send = (id: number, method: string): Promise<void> =>
					dispatch_ws_message(
						onMessage,
						new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', id, method }) }),
						socket.ws
					);

				const stalled = h.gated.stall(is_audit_insert);
				const revoking = send(1, 'account_session_revoke_all');
				await stalled.reached;
				try {
					await until(
						() => socket.closes.length > 0,
						'the socket stayed open while the audit write was held'
					);
					assert.deepStrictEqual(socket.closes, [
						{ code: WS_CLOSE_SESSION_REVOKED, reason: WS_CLOSE_SESSION_REVOKED_REASON }
					]);
					assert.strictEqual(await no_sessions(h.db, account_id), true, 'the revoke committed');
					// the caller read its reply first
					assert.strictEqual(socket.sends.length, 1);
					const reply = JSON.parse(socket.sends[0]!) as { id: number; result?: { ok: boolean } };
					assert.strictEqual(reply.id, 1);
					assert.strictEqual(reply.result?.ok, true);

					// and nothing more runs on the revoked session's socket
					await send(2, 'account_session_list');
					assert.strictEqual(socket.sends.length, 1, 'a later frame is not dispatched');
				} finally {
					stalled.release();
				}
				await revoking;
				await h.test_app.cleanup();
			});
		});
	});

	describe('a committed revocation whose RPC response cannot be built', () => {
		// The RPC route runs with `transaction: false` — `perform_action` owns
		// the transaction and has committed by the time the response is
		// serialized. A throw there reaches the route wrapper, which reads a
		// throw as a rollback and discards the post-commit queue.
		const revoke_unserializable_spec = {
			method: 'revoke_unserializable',
			kind: 'request_response',
			initiator: 'frontend',
			auth: { account: 'required', actor: 'none' },
			side_effects: true,
			input: z.void(),
			output: z.strictObject({ n: z.bigint() }),
			async: true,
			description: 'revoke every session of the caller, then return a value JSON cannot carry'
		} satisfies RequestResponseActionSpec;

		test('answers internal_error and still closes', async () => {
			const { closer, calls } = create_recording_closer();
			const db = get_db();
			const test_app = await create_test_app({
				session_options,
				db,
				create_route_specs: (ctx) => {
					ctx.deps.connection_closer.add(closer);
					return create_rpc_endpoint({
						path: RPC_PATH,
						actions: [
							rpc_action(revoke_unserializable_spec, async (_input, action_ctx) => {
								const { id } = action_ctx.auth.account;
								await query_session_revoke_all_for_account(action_ctx, id);
								queue_connection_close(action_ctx, ctx.deps.connection_closer, {
									kind: 'account',
									account_id: id
								});
								return { n: 1n };
							})
						],
						log: ctx.deps.log
					});
				}
			});
			const account_id = test_app.backend.account.id;

			const res = await test_app.app.request(RPC_PATH, {
				method: 'POST',
				headers: test_app.create_session_headers({ 'Content-Type': 'application/json' }),
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 'unserializable',
					method: 'revoke_unserializable'
				})
			});

			// the revocation committed …
			const sessions = await db.query('SELECT 1 FROM auth_session WHERE account_id = $1', [
				account_id
			]);
			assert.deepStrictEqual(sessions, [], 'the sessions are gone');
			// … so its close must have run
			assert.strictEqual(calls.length, 1, 'the committed revocation closed');
			assert_close_call(calls[0], 'account', account_id);
			// and the caller is answered a JSON-RPC error, not a bare 500
			assert.strictEqual(res.status, 500);
			const body = (await res.json()) as { jsonrpc: string; id: string; error: { code: number } };
			assert.strictEqual(body.jsonrpc, '2.0');
			assert.strictEqual(body.id, 'unserializable');
			assert.strictEqual(body.error.code, JSONRPC_ERROR_CODES.internal_error);
			await test_app.cleanup();
		});
	});

	describe('the caps close nothing when they evict nothing', () => {
		test('a login under the session cap queues no close', async () => {
			const { closer, calls } = create_recording_closer();
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db()
			});
			const res = await test_app.app.request('/api/account/login', {
				method: 'POST',
				headers: {
					host: 'localhost',
					origin: 'http://localhost:5173',
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ username: 'keeper', password: DEFAULT_TEST_PASSWORD })
			});
			assert.strictEqual(res.status, 200);
			assert.deepStrictEqual(calls, []);
			await test_app.cleanup();
		});
	});
});
