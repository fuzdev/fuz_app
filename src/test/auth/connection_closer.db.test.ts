/**
 * Wiring coverage for the `connection_closer` capability across
 * self-service account actions, admin revoke-all actions, and the REST
 * logout / password routes.
 *
 * Asserts that:
 * 1. Every gated handler calls the appropriate `close_sockets_for_*`
 *    method when the capability is injected. Per-test assertions use
 *    the `assert_close_call(calls[n], method, id)` helper — it pins
 *    `{method, id}` only, leaving the sequence-number authority to the
 *    dedicated ordering test (see #2).
 * 2. The eager close fires BEFORE the audit emit at the handler call
 *    site. Verified by the dedicated `audit emit ordering — close fires
 *    before audit.emit at the call site` block below, which hot-patches
 *    the `AppDeps.audit.emit` slot on the live backend to record into
 *    the same sequence-numbered array the closer pushes into. Audit
 *    emit is fire-and-forget so its DB-write timing isn't observable
 *    from the closer's sequence counter on the other tests — that's
 *    why those tests use the helper instead of pinning `at: N`.
 * 3. Failure outcomes (revoked=false from IDOR mismatch or
 *    cross-account probe) do NOT trigger eager close — same shape the
 *    listener uses, attackers cannot target arbitrary sessions/tokens
 *    by guessing ids OR by passing real other-account ids.
 * 4. When `connection_closer` is absent, handlers run cleanly and the
 *    audit listener remains the only close seam (backwards compat).
 * 5. Every test runs under the `beforeEach`/`afterEach` audit-drift
 *    guard at the top of `describe_db`: if any handler emits metadata
 *    that fails `audit_metadata_schemas`, the process-wide counter in
 *    `audit_log_queries.ts` bumps and the after-each assertion fails.
 *    Same shape for unknown `event_type` values. Catches regressions
 *    that production would swallow (the schema validation is
 *    fail-open in `query_audit_log`).
 *
 * Mirrors `zzz_server`'s handler-side `close_sockets_for_*` calls
 * landed 2026-05-16.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_account_route_specs} from '$lib/auth/account_routes.js';
import {create_account_actions} from '$lib/auth/account_actions.js';
import {create_admin_actions} from '$lib/auth/admin_actions.js';
import {create_standard_rpc_actions} from '$lib/auth/standard_rpc_actions.js';
import {
	account_session_revoke_action_spec,
	account_session_revoke_all_action_spec,
	account_token_revoke_action_spec,
} from '$lib/auth/account_action_specs.js';
import {
	admin_session_revoke_all_action_spec,
	admin_token_revoke_all_action_spec,
} from '$lib/auth/admin_action_specs.js';
import {ERROR_CREDENTIAL_TYPE_REQUIRED, ERROR_ACCOUNT_NOT_FOUND} from '$lib/http/error_schemas.js';
import {create_rpc_endpoint} from '$lib/actions/action_rpc.js';
import type {ConnectionCloser} from '$lib/actions/connection_closer.js';
import {auth_migration_ns} from '$lib/auth/migrations.js';
import {create_test_app, DEFAULT_TEST_PASSWORD} from '$lib/testing/app_server.js';
import {create_test_account_with_actor} from '$lib/testing/db_entities.js';
import {
	auth_integration_truncate_tables,
	create_describe_db,
	create_pglite_factory,
} from '$lib/testing/db.js';
import {rpc_call_for_spec, rpc_call} from '$lib/testing/rpc_helpers.js';
import {find_auth_route} from '$lib/testing/integration_helpers.js';
import {
	install_audit_drift_guard,
	create_emit_ordering_audit_factory,
} from '$lib/testing/audit_drift_guard.js';
import {create_audit_emitter} from '$lib/auth/audit_emitter.js';
import {
	assert_close_call,
	create_recording_closer,
} from '$lib/testing/connection_closer_helpers.js';
import {run_migrations} from '$lib/db/migrate.js';
import type {Db} from '$lib/db/db.js';
import type {AppServerContext} from '$lib/server/app_server_context.js';
import {prefix_route_specs, type RouteSpec} from '$lib/http/route_spec.js';
import {ROLE_ADMIN, ROLE_KEEPER} from '$lib/auth/role_schema.js';
import type {AuditLogEvent} from '$lib/auth/audit_log_schema.js';

const session_options = create_session_config('test_session');
const RPC_PATH = '/api/rpc';

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [auth_migration_ns]);
};
const factory = create_pglite_factory(init_schema);
const describe_db = create_describe_db(factory, auth_integration_truncate_tables);

const make_create_route_specs =
	(closer: ConnectionCloser | null) =>
	(ctx: AppServerContext): Array<RouteSpec> => [
		...prefix_route_specs(
			'/api/account',
			create_account_route_specs(ctx.deps, {
				session_options,
				ip_rate_limiter: ctx.ip_rate_limiter,
				login_account_rate_limiter: ctx.login_account_rate_limiter,
				login_fail_floor_ms: 0,
				connection_closer: closer,
			}),
		),
		...create_rpc_endpoint({
			path: RPC_PATH,
			actions: [
				...create_account_actions(ctx.deps, {connection_closer: closer}),
				...create_admin_actions(ctx.deps, {connection_closer: closer}),
			],
			log: ctx.deps.log,
		}),
	];

describe_db('connection_closer wiring', (get_db) => {
	// Audit-drift guard — fails any test whose audit emits land an
	// undeclared metadata field or an unknown event_type (production
	// validation in `query_audit_log` is fail-open; without this we'd
	// silently swallow the same regressions). See
	// `testing/audit_drift_guard.ts`. `await_pending_effects: true` on
	// the test app guarantees fire-and-forget audit writes have completed
	// by response time, so the after-each check observes final state.
	install_audit_drift_guard();

	describe('account_actions (self-service)', () => {
		test('account_session_revoke closes the session socket on success', async () => {
			const {closer, calls} = create_recording_closer();
			const audit_events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				audit_factory: (params) =>
					create_audit_emitter({...params, on_audit_event: (e) => audit_events.push(e)}),
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
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(list_res.ok, true);
			const listed = list_res.ok
				? (list_res.result as {sessions: Array<{id: string}>})
				: {sessions: []};
			assert.strictEqual(listed.sessions.length, 1, 'exactly one bootstrap session expected');
			const session_id = listed.sessions[0]!.id;

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_session_revoke_action_spec,
				params: {session_id: session_id as never},
				headers: test_app.create_session_headers(),
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
			const {closer, calls} = create_recording_closer();
			const audit_events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				audit_factory: (params) =>
					create_audit_emitter({...params, on_audit_event: (e) => audit_events.push(e)}),
			});
			// blake3 hash format but not a real session
			const bogus_hash = 'a'.repeat(64);
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_session_revoke_action_spec,
				params: {session_id: bogus_hash},
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(res.ok, true);
			if (res.ok) assert.strictEqual(res.result.revoked, false);
			assert.strictEqual(
				calls.length,
				0,
				'closer must NOT fire on failed revoke — attacker-guessable ids',
			);
			// Pin the failure-outcome audit row — without it, a regression dropping
			// BOTH the eager close AND the failure audit would slip past the close-
			// only assertion above. The attacker-supplied `session_id` echoes back
			// into metadata so forensics can spot enumeration attempts.
			const failure_audits = audit_events.filter(
				(e) => e.event_type === 'session_revoke' && e.outcome === 'failure',
			);
			assert.strictEqual(failure_audits.length, 1);
			const meta = failure_audits[0]!.metadata as {session_id?: string};
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
			const {closer, calls} = create_recording_closer();
			const audit_events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				audit_factory: (params) =>
					create_audit_emitter({...params, on_audit_event: (e) => audit_events.push(e)}),
			});
			const target = await test_app.create_account({username: 'crossaccttarget'});
			// Discover the target's session id via the list RPC against the
			// target's own headers — same dance as the happy-path test above.
			const list_res = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: 'account_session_list',
				headers: target.create_session_headers(),
			});
			assert.strictEqual(list_res.ok, true);
			const listed = list_res.ok
				? (list_res.result as {sessions: Array<{id: string}>})
				: {sessions: []};
			assert.strictEqual(listed.sessions.length, 1, 'target has one session');
			const target_session_id = listed.sessions[0]!.id;
			// Reset call log — the list call doesn't close, but be defensive.
			calls.length = 0;

			// First account (bootstrap session) attempts to revoke the target's session.
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_session_revoke_action_spec,
				params: {session_id: target_session_id as never},
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(res.ok, true);
			if (res.ok) assert.strictEqual(res.result.revoked, false);
			assert.strictEqual(
				calls.length,
				0,
				'closer must NOT fire on cross-account revoke — IDOR via the closer would be a worse leak than the audit row',
			);

			// Target session is still alive — IDOR didn't bypass the guard at the SQL level either.
			const target_list_after = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: 'account_session_list',
				headers: target.create_session_headers(),
			});
			assert.strictEqual(target_list_after.ok, true);
			const target_listed_after = target_list_after.ok
				? (target_list_after.result as {sessions: Array<{id: string}>})
				: {sessions: []};
			assert.strictEqual(
				target_listed_after.sessions.length,
				1,
				'target session still alive after cross-account revoke attempt',
			);

			// Failure-outcome audit fires under the first account_id with the
			// probed session_id in metadata — matches the id-mismatch shape.
			const failure_audits = audit_events.filter(
				(e) => e.event_type === 'session_revoke' && e.outcome === 'failure',
			);
			assert.strictEqual(failure_audits.length, 1);
			const meta = failure_audits[0]!.metadata as {session_id?: string};
			assert.strictEqual(meta.session_id, target_session_id);
			assert.strictEqual(
				failure_audits[0]!.account_id,
				test_app.backend.account.id,
				'audit pins the calling account, not the target',
			);
			await test_app.cleanup();
		});

		test('account_session_revoke_all closes the account', async () => {
			// `count` is always ≥ 1 on this surface — the caller is using the
			// session they're revoking. The "count: 0, close still fires"
			// contract is admin-only (admin can target any account, including
			// ones with no live sessions); the self-service surface can't
			// reach the count-zero branch from the public API.
			const {closer, calls} = create_recording_closer();
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
			});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_session_revoke_all_action_spec,
				params: undefined,
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(res.ok, true);
			if (res.ok)
				assert.strictEqual(res.result.count, 1, 'bootstrap session was the only active session');
			assert.strictEqual(calls.length, 1);
			assert_close_call(calls[0], 'account', test_app.backend.account.id);
			await test_app.cleanup();
		});

		test('account_token_revoke closes the token socket on success', async () => {
			const {closer, calls} = create_recording_closer();
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
			});
			// Create a fresh token via the RPC surface so we have its id —
			// the test_app fixture's `api_token` is the raw token string only.
			const create_res = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: 'account_token_create',
				params: {name: 'closer_target'},
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(create_res.ok, true);
			const created = create_res.ok ? (create_res.result as {id: string}) : {id: ''};
			const token_id = created.id;
			// `account_token_create` must NOT fire the closer — it's a
			// creation, not a revocation. Without this pin, a copy-paste
			// refactor that wired the closer into the create handler would
			// pass the revoke assertion below (`calls.length === 1` after
			// the reset) but silently emit a spurious close call for every
			// new token. The reset below would mask the regression.
			assert.strictEqual(calls.length, 0, 'token_create must NOT fire the closer');
			// Reset call log so we only capture the revoke's eager close.
			calls.length = 0;

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_token_revoke_action_spec,
				params: {token_id: token_id as never},
				headers: test_app.create_session_headers(),
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
			const {closer, calls} = create_recording_closer();
			const audit_events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				audit_factory: (params) =>
					create_audit_emitter({...params, on_audit_event: (e) => audit_events.push(e)}),
			});
			const bogus_token = 'tok_aaaaaaaaaaaa';
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_token_revoke_action_spec,
				params: {token_id: bogus_token},
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(res.ok, true);
			if (res.ok) assert.strictEqual(res.result.revoked, false);
			assert.strictEqual(calls.length, 0);
			// Symmetric to the `account_session_revoke` failure-audit pin above —
			// a regression that dropped close AND failure audit together would
			// otherwise pass.
			const failure_audits = audit_events.filter(
				(e) => e.event_type === 'token_revoke' && e.outcome === 'failure',
			);
			assert.strictEqual(failure_audits.length, 1);
			const meta = failure_audits[0]!.metadata as {token_id?: string};
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
			const {closer, calls} = create_recording_closer();
			const audit_events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				audit_factory: (params) =>
					create_audit_emitter({...params, on_audit_event: (e) => audit_events.push(e)}),
			});
			const target = await test_app.create_account({username: 'crossaccttoken'});
			// Create a token on the target account so we have a real id to probe.
			const create_res = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: 'account_token_create',
				params: {name: 'target_owned'},
				headers: target.create_session_headers(),
			});
			assert.strictEqual(create_res.ok, true);
			const created = create_res.ok ? (create_res.result as {id: string}) : {id: ''};
			const target_token_id = created.id;
			calls.length = 0;

			// First account attempts to revoke the target's token.
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_token_revoke_action_spec,
				params: {token_id: target_token_id as never},
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(res.ok, true);
			if (res.ok) assert.strictEqual(res.result.revoked, false);
			assert.strictEqual(calls.length, 0, 'closer must NOT fire on cross-account token revoke');

			// Target's token is still listed — IDOR didn't bypass the guard.
			const target_list = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: 'account_token_list',
				headers: target.create_session_headers(),
			});
			assert.strictEqual(target_list.ok, true);
			const target_listed = target_list.ok
				? (target_list.result as {tokens: Array<{id: string}>})
				: {tokens: []};
			assert.ok(
				target_listed.tokens.some((t) => t.id === target_token_id),
				'target token still present after cross-account revoke attempt',
			);

			const failure_audits = audit_events.filter(
				(e) => e.event_type === 'token_revoke' && e.outcome === 'failure',
			);
			assert.strictEqual(failure_audits.length, 1);
			const meta = failure_audits[0]!.metadata as {token_id?: string};
			assert.strictEqual(meta.token_id, target_token_id);
			assert.strictEqual(
				failure_audits[0]!.account_id,
				test_app.backend.account.id,
				'audit pins the calling account, not the target',
			);
			await test_app.cleanup();
		});
	});

	describe('admin_actions (revoke-all)', () => {
		test('admin_session_revoke_all closes the target account', async () => {
			const {closer, calls} = create_recording_closer();
			const audit_events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				roles: [ROLE_KEEPER, ROLE_ADMIN],
				audit_factory: (params) =>
					create_audit_emitter({...params, on_audit_event: (e) => audit_events.push(e)}),
			});
			// Create a second account to revoke against
			const target = await test_app.create_account({username: 'closertarget'});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: admin_session_revoke_all_action_spec,
				params: {account_id: target.account.id},
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(res.ok, true);
			assert.strictEqual(calls.length, 1);
			// Close-vs-audit ordering isn't load-bearing here — `deps.audit.emit`
			// is fire-and-forget and can't throw synchronously, so what matters
			// is *inclusion* (close runs in the handler at all) not relative
			// position. The audit success-shape assertions below pin the row's
			// `target_account_id` + `metadata.count` so a refactor that dropped
			// either would surface.
			assert_close_call(calls[0], 'account', target.account.id);
			const success_audits = audit_events.filter(
				(e) => e.event_type === 'session_revoke_all' && e.outcome === 'success',
			);
			assert.strictEqual(success_audits.length, 1);
			assert.strictEqual(success_audits[0]!.target_account_id, target.account.id);
			const success_meta = success_audits[0]!.metadata as {count?: number};
			assert.strictEqual(typeof success_meta.count, 'number');
			await test_app.cleanup();
		});

		test('admin_token_revoke_all closes the target account', async () => {
			const {closer, calls} = create_recording_closer();
			const audit_events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				roles: [ROLE_KEEPER, ROLE_ADMIN],
				audit_factory: (params) =>
					create_audit_emitter({...params, on_audit_event: (e) => audit_events.push(e)}),
			});
			const target = await test_app.create_account({username: 'closertarget2'});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: admin_token_revoke_all_action_spec,
				params: {account_id: target.account.id},
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(res.ok, true);
			assert.strictEqual(calls.length, 1);
			assert_close_call(calls[0], 'account', target.account.id);
			// Mirror the session-revoke-all success-shape assertions above —
			// pin `target_account_id` populated and `metadata.count` set.
			const success_audits = audit_events.filter(
				(e) => e.event_type === 'token_revoke_all' && e.outcome === 'success',
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
				'admin token_revoke_all does not carry credential_type by design',
			);
			await test_app.cleanup();
		});

		test('admin_session_revoke_all does NOT close on account-not-found 404', async () => {
			const {closer, calls} = create_recording_closer();
			const audit_events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				roles: [ROLE_KEEPER, ROLE_ADMIN],
				audit_factory: (params) =>
					create_audit_emitter({...params, on_audit_event: (e) => audit_events.push(e)}),
			});
			const bogus_id = '00000000-0000-0000-0000-000000000000';
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: admin_session_revoke_all_action_spec,
				params: {account_id: bogus_id as never},
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(res.ok, false);
			assert.strictEqual(res.status, 404);
			assert.strictEqual(
				calls.length,
				0,
				'closer must not fire on the not-found path — closes attacker-guessable ids otherwise',
			);
			// Forensics shape per `admin_actions.ts::session_revoke_all_handler`:
			// `target_account_id` is null (FK forces it) and the probed id is
			// preserved under `metadata.attempted_account_id`. Pins the
			// documented contract so a refactor that drops the metadata write
			// (or accidentally writes the bogus id into the FK column) trips here.
			const failure_audits = audit_events.filter(
				(e) => e.event_type === 'session_revoke_all' && e.outcome === 'failure',
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
			const {closer, calls} = create_recording_closer();
			const audit_events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				roles: [ROLE_KEEPER, ROLE_ADMIN],
				audit_factory: (params) =>
					create_audit_emitter({...params, on_audit_event: (e) => audit_events.push(e)}),
			});
			const bogus_id = '00000000-0000-0000-0000-000000000000';
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: admin_token_revoke_all_action_spec,
				params: {account_id: bogus_id as never},
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(res.ok, false);
			assert.strictEqual(res.status, 404);
			assert.strictEqual(calls.length, 0);
			const failure_audits = audit_events.filter(
				(e) => e.event_type === 'token_revoke_all' && e.outcome === 'failure',
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
			// that exists but has no active sessions still triggers the eager
			// close. The handler returns count: 0 and the closer records a single
			// account-wide call. Without this test, a refactor that gated the
			// close on `if (count > 0)` (a plausible micro-optimization) would
			// pass every other admin test in this file (each of which seeds at
			// least one session via the higher-level `create_account` helper).
			const {closer, calls} = create_recording_closer();
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				roles: [ROLE_KEEPER, ROLE_ADMIN],
			});
			// Bare DB account — no session, no token, no role_grant.
			const target = await create_test_account_with_actor(get_db(), {
				username: 'nolivesessions',
			});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: admin_session_revoke_all_action_spec,
				params: {account_id: target.account.id},
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(res.ok, true);
			if (res.ok) assert.strictEqual(res.result.count, 0);
			assert.strictEqual(calls.length, 1, 'close fires unconditionally on the success path');
			assert_close_call(calls[0], 'account', target.account.id);
			await test_app.cleanup();
		});

		test('admin_token_revoke_all closes the target account when count is zero', async () => {
			// Symmetric to the `admin_session_revoke_all` zero-count test above.
			const {closer, calls} = create_recording_closer();
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				roles: [ROLE_KEEPER, ROLE_ADMIN],
			});
			const target = await create_test_account_with_actor(get_db(), {
				username: 'nolivetokens',
			});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: admin_token_revoke_all_action_spec,
				params: {account_id: target.account.id},
				headers: test_app.create_session_headers(),
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
			const {closer, calls} = create_recording_closer();
			const audit_events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				audit_factory: (params) =>
					create_audit_emitter({...params, on_audit_event: (e) => audit_events.push(e)}),
			});
			const logout_route = find_auth_route(test_app.route_specs, '/logout', 'POST');
			assert.ok(logout_route, 'logout route registered');
			const res = await test_app.app.request(logout_route.path, {
				method: 'POST',
				headers: test_app.create_session_headers(),
				body: null,
			});
			assert.strictEqual(res.status, 200);
			assert.strictEqual(calls.length, 1, 'closer fired once');
			// Eager close is ACCOUNT-WIDE — matches the Rust `account_logout`
			// handler and the sibling `/password` handler. Only the current
			// session ROW is deleted (token-hash-scoped), but the socket close is
			// account-grain — the same scope the `create_ws_logout_closer` audit
			// listener applies, so the eager + listener seams converge.
			assert_close_call(calls[0], 'account', test_app.backend.account.id);
			// Pin `event_type: 'logout'` (NOT `session_revoke`) on the audit row.
			// This is the central invariant of the dual-seam WS close architecture:
			// `ws_disconnect_event_types` in `transports_ws_auth_guard.ts` excludes
			// `logout` deliberately so `create_ws_auth_guard` does not fire here.
			// The listener-based seam for logout is the SEPARATE `create_ws_logout_closer`,
			// which also closes account-wide. A refactor that emitted `session_revoke`
			// here would silently swap which listener fires — catastrophic for
			// SSE-stream-revocation logic and admin forensics.
			const logout_audits = audit_events.filter((e) => e.event_type === 'logout');
			assert.strictEqual(logout_audits.length, 1, 'logout emits exactly one logout audit row');
			const stray_session_revoke = audit_events.filter((e) => e.event_type === 'session_revoke');
			assert.strictEqual(
				stray_session_revoke.length,
				0,
				'logout must NOT emit a session_revoke event — see ws_disconnect_event_types',
			);
			await test_app.cleanup();
		});

		test('password change closes all account sockets', async () => {
			const {closer, calls} = create_recording_closer();
			const audit_events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				audit_factory: (params) =>
					create_audit_emitter({...params, on_audit_event: (e) => audit_events.push(e)}),
			});
			const password_route = find_auth_route(test_app.route_specs, '/password', 'POST');
			assert.ok(password_route, 'password route registered');
			const res = await test_app.app.request(password_route.path, {
				method: 'POST',
				headers: {
					...test_app.create_session_headers(),
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					current_password: DEFAULT_TEST_PASSWORD,
					new_password: 'new-test-password-xyz',
				}),
			});
			assert.strictEqual(res.status, 200);
			assert.strictEqual(calls.length, 1, 'closer fired once for the account-wide revoke');
			// Audit-vs-close ordering isn't load-bearing here — audit emit is
			// fire-and-forget. The inclusion contract is what matters; the
			// dedicated ordering test at the bottom of this file proves the
			// pre-emit sequencing.
			assert_close_call(calls[0], 'account', test_app.backend.account.id);
			// Pin the defense-in-depth `credential_type` field on the
			// success-path audit metadata (see `docs/security.md`
			// §Credential-channel gating). A refactor that drops the field
			// from `account_routes.ts::password` would silently break
			// forensic visibility into which credential channel performed
			// the password change.
			const success_audits = audit_events.filter(
				(e) => e.event_type === 'password_change' && e.outcome === 'success',
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
			const {closer, calls} = create_recording_closer();
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
			});
			const logout_route = find_auth_route(test_app.route_specs, '/logout', 'POST');
			assert.ok(logout_route, 'logout route registered');
			const res = await test_app.app.request(logout_route.path, {
				method: 'POST',
				headers: test_app.create_bearer_headers(),
				body: null,
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
				'closer must not fire when the credential gate refuses the caller',
			);
			await test_app.cleanup();
		});

		test('password change does NOT close on wrong-password 401', async () => {
			const {closer, calls} = create_recording_closer();
			const audit_events: Array<AuditLogEvent> = [];
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				audit_factory: (params) =>
					create_audit_emitter({...params, on_audit_event: (e) => audit_events.push(e)}),
			});
			const password_route = find_auth_route(test_app.route_specs, '/password', 'POST');
			assert.ok(password_route, 'password route registered');
			const res = await test_app.app.request(password_route.path, {
				method: 'POST',
				headers: {
					...test_app.create_session_headers(),
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					current_password: 'wrong-password-xx',
					new_password: 'new-test-password-xyz',
				}),
			});
			assert.strictEqual(res.status, 401);
			assert.strictEqual(calls.length, 0, 'closer must not fire on wrong-password failure');
			// Pin the failure audit so a regression that dropped both the eager
			// close AND the failure audit would surface here. `credential_type`
			// is the defense-in-depth field from `docs/security.md` §Credential-
			// channel gating — present on every outcome of `password_change`.
			const failure_audits = audit_events.filter(
				(e) => e.event_type === 'password_change' && e.outcome === 'failure',
			);
			assert.strictEqual(failure_audits.length, 1);
			const meta = failure_audits[0]!.metadata as {credential_type?: string};
			assert.strictEqual(meta.credential_type, 'session');
			await test_app.cleanup();
		});
	});

	describe('standard_rpc_actions bundle wires connection_closer', () => {
		// The per-factory tests above exercise `create_account_actions` and
		// `create_admin_actions` directly. The `create_standard_rpc_actions`
		// bundle spreads its options object into all three sub-factories via
		// structural typing — `connection_closer` flows to admin + account
		// today, role-grant-offer ignores it. A refactor to per-sub-factory
		// option picks that forgot to thread `connection_closer` would
		// silently disable the closer for consumers using the bundle. Two
		// assertions — one account-side, one admin-side — guard against
		// asymmetric regressions where only one of the two sub-factory
		// option threads breaks.
		test('account + admin handlers both fire the closer when wired via the bundle', async () => {
			const {closer, calls} = create_recording_closer();
			const test_app = await create_test_app({
				session_options,
				create_route_specs: (ctx: AppServerContext): Array<RouteSpec> => [
					...prefix_route_specs(
						'/api/account',
						create_account_route_specs(ctx.deps, {
							session_options,
							ip_rate_limiter: ctx.ip_rate_limiter,
							login_account_rate_limiter: ctx.login_account_rate_limiter,
							login_fail_floor_ms: 0,
							connection_closer: closer,
						}),
					),
					...create_rpc_endpoint({
						path: RPC_PATH,
						actions: create_standard_rpc_actions(ctx.deps, {connection_closer: closer}),
						log: ctx.deps.log,
					}),
				],
				db: get_db(),
				roles: [ROLE_KEEPER, ROLE_ADMIN],
			});

			// admin-side first — exercises the admin sub-factory's option
			// thread. Run before the account-side revoke because the latter
			// kills the bootstrap session this admin call authenticates with.
			// Catches the asymmetric regression where the admin sub-factory
			// drops `connection_closer` while the account side keeps it.
			const target = await test_app.create_account({username: 'bundleadmintarget'});
			const admin_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: admin_session_revoke_all_action_spec,
				params: {account_id: target.account.id},
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(admin_res.ok, true);
			assert.strictEqual(
				calls.length,
				1,
				'standard bundle wired closer into admin_session_revoke_all',
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
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(list_res.ok, true);
			const listed = list_res.ok
				? (list_res.result as {sessions: Array<{id: string}>})
				: {sessions: []};
			const session_id = listed.sessions[0]!.id;

			const account_res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_session_revoke_action_spec,
				params: {session_id: session_id as never},
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(account_res.ok, true);
			assert.strictEqual(
				calls.length,
				1,
				'standard bundle wired closer into account_session_revoke',
			);
			assert_close_call(calls[0], 'session', session_id);

			await test_app.cleanup();
		});
	});

	describe('absent closer (backwards compat)', () => {
		// Each gated handler must still complete cleanly without a closer —
		// the pre-belt+suspenders configuration that pure listener-based
		// close represents. Without per-handler coverage, a regression that
		// drops `connection_closer ?? null` into `connection_closer!.…`
		// silently survives the existing single-handler smoke test. These
		// tests pin the no-closer contract on every site that wired the
		// capability.

		test('account_session_revoke_all completes without a connection_closer', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(null),
				db: get_db(),
			});
			const res = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: 'account_session_revoke_all',
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(res.ok, true);
			await test_app.cleanup();
		});

		test('account_session_revoke completes without a closer', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(null),
				db: get_db(),
			});
			// Same id-discovery dance as the closer-present test — see
			// account_session_revoke happy-path comment above.
			const list_res = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: 'account_session_list',
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(list_res.ok, true);
			const listed = list_res.ok
				? (list_res.result as {sessions: Array<{id: string}>})
				: {sessions: []};
			const session_id = listed.sessions[0]!.id;
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_session_revoke_action_spec,
				params: {session_id: session_id as never},
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(res.ok, true);
			await test_app.cleanup();
		});

		test('account_token_revoke completes without a closer', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(null),
				db: get_db(),
			});
			const create_res = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: 'account_token_create',
				params: {name: 'absent_closer_target'},
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(create_res.ok, true);
			const created = create_res.ok ? (create_res.result as {id: string}) : {id: ''};
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_token_revoke_action_spec,
				params: {token_id: created.id as never},
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(res.ok, true);
			await test_app.cleanup();
		});

		test('admin_session_revoke_all completes without a closer', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(null),
				db: get_db(),
				roles: [ROLE_KEEPER, ROLE_ADMIN],
			});
			const target = await test_app.create_account({username: 'absentcloser1'});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: admin_session_revoke_all_action_spec,
				params: {account_id: target.account.id},
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(res.ok, true);
			await test_app.cleanup();
		});

		test('admin_token_revoke_all completes without a closer', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(null),
				db: get_db(),
				roles: [ROLE_KEEPER, ROLE_ADMIN],
			});
			const target = await test_app.create_account({username: 'absentcloser2'});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: admin_token_revoke_all_action_spec,
				params: {account_id: target.account.id},
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(res.ok, true);
			await test_app.cleanup();
		});

		test('REST logout completes without a closer', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(null),
				db: get_db(),
			});
			const logout_route = find_auth_route(test_app.route_specs, '/logout', 'POST');
			assert.ok(logout_route, 'logout route registered');
			const res = await test_app.app.request(logout_route.path, {
				method: 'POST',
				headers: test_app.create_session_headers(),
				body: null,
			});
			assert.strictEqual(res.status, 200);
			await test_app.cleanup();
		});

		test('REST password change completes without a closer', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(null),
				db: get_db(),
			});
			const password_route = find_auth_route(test_app.route_specs, '/password', 'POST');
			assert.ok(password_route, 'password route registered');
			const res = await test_app.app.request(password_route.path, {
				method: 'POST',
				headers: {
					...test_app.create_session_headers(),
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					current_password: DEFAULT_TEST_PASSWORD,
					new_password: 'new-test-password-xyz',
				}),
			});
			assert.strictEqual(res.status, 200);
			await test_app.cleanup();
		});
	});

	describe('audit emit ordering — close fires before audit.emit at the call site', () => {
		// The contract documented in `actions/connection_closer.ts` and in
		// every handler is: the eager close runs SYNCHRONOUSLY BEFORE
		// `deps.audit.emit(ctx, ...)` so the close lands even if the
		// in-flight audit pool write fails. The `at: 0` assertions across
		// this file only prove single-call inclusion on a fresh recording
		// closer — they cannot pin the close-vs-emit ordering because the
		// closer's sequence counter has no input from the audit emit path.
		//
		// This block wires `create_emit_ordering_audit_factory` through
		// `create_test_app({audit_factory})`. The factory builds the real
		// audit emitter with an `emit_decorator` that pushes a marker into
		// the same sequence-numbered array the closer pushes into, so a
		// refactor that moved the close BELOW the audit emit call site
		// trips here. The decorator is captured by both `emit` and
		// `emit_role_grant_target` inside `create_audit_emitter`, so
		// ordering capture survives any future move of a close-firing
		// handler from the lower-level `emit` to the role-grant-shape
		// `emit_role_grant_target` wrapper.
		//
		// One representative test per handler family would be overkill —
		// the ordering contract is the same source-level pattern in every
		// handler. Pinning `account_session_revoke` is sufficient to
		// catch a refactor that swept across all sites; per-family
		// regressions would still be caught by the failure-outcome tests
		// (`does NOT close on failure`) which fire if the close moved past
		// any conditional gate.
		test('account_session_revoke closes BEFORE audit.emit at the source level', async () => {
			const seq = {value: 0};
			const events: Array<{kind: 'close' | 'emit'; at: number}> = [];
			// Bespoke session-only closer that pushes the `close` marker
			// into the shared `events` array (rather than the
			// `RecordedClose` shape `create_recording_closer` writes) so
			// the close + emit markers compose without per-record shape
			// reconciliation. The dedicated ordering test is the only
			// site that needs this — every other test uses
			// `create_recording_closer` + `assert_close_call`.
			const closer: ConnectionCloser = {
				close_sockets_for_session: () => {
					events.push({kind: 'close', at: seq.value++});
					return 1;
				},
				close_sockets_for_token: () => 0,
				close_sockets_for_account: () => 0,
			};
			// Decorate the real emitter at backend-build time via
			// `audit_factory` — pushes `{kind: 'emit'}` markers into the
			// shared `events` array on every `audit.emit` call (and on
			// `audit.emit_role_grant_target`, since both route through the
			// same closure-captured decorator inside `create_audit_emitter`)
			// so close + emit ordering can be asserted against one
			// sequence counter. Production handlers dereference
			// `deps.audit.emit` at call time, so the decorator sees every
			// subsequent handler invocation.
			const test_app = await create_test_app({
				session_options,
				create_route_specs: make_create_route_specs(closer),
				db: get_db(),
				audit_factory: create_emit_ordering_audit_factory(seq, events),
			});

			// Resolve the session id via the list RPC, then revoke it.
			// The list call's read handler does not call audit.emit, so
			// the events array stays empty up to the revoke call.
			const list_res = await rpc_call({
				app: test_app.app,
				path: RPC_PATH,
				method: 'account_session_list',
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(list_res.ok, true);
			const listed = list_res.ok
				? (list_res.result as {sessions: Array<{id: string}>})
				: {sessions: []};
			const session_id = listed.sessions[0]!.id;
			// Reset in case the list path ever gains an audit emit.
			events.length = 0;
			seq.value = 0;

			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_session_revoke_action_spec,
				params: {session_id: session_id as never},
				headers: test_app.create_session_headers(),
			});
			assert.strictEqual(res.ok, true);

			// Exactly two events: one close, one emit.
			assert.strictEqual(events.length, 2, `expected close + emit, got ${JSON.stringify(events)}`);
			// Ordering claim: close (at: 0) before emit (at: 1).
			assert.deepStrictEqual(events[0], {kind: 'close', at: 0});
			assert.deepStrictEqual(events[1], {kind: 'emit', at: 1});

			await test_app.cleanup();
		});
	});
});
