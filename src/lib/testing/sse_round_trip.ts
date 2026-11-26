import './assert_dev_env.ts';

/**
 * Schema-driven SSE route validation test suite.
 *
 * Complements `describe_round_trip_validation` (which skips SSE routes).
 * For each configured SSE route:
 * 1. Open the stream with matching auth.
 * 2. Assert the `: connected` comment is emitted.
 * 3. Fire `trigger()` — expect one `data: {...}` frame.
 * 4. Validate the payload as `{method, params}` against declared `EventSpec`s.
 * 5. Fire `session_revoke_all` for the account and assert the stream closes
 *    (when `assert_closes_on_revoke !== false`).
 *
 * @module
 */

import { describe, test, beforeAll, afterAll, assert } from 'vitest';
import { parse } from '@fuzdev/fuz_schema/schema.ts';

import type { RouteSpec } from '../http/route_spec.ts';
import type { RouteAuth } from '../http/auth_shape.ts';
import type { AppServerContext } from '../server/app_server_context.ts';
import type { EventSpec, SseNotification } from '../realtime/sse.ts';
import { SSE_CONNECTED_COMMENT } from '../realtime/sse_constants.ts';
import { ROLE_ADMIN } from '../auth/role_schema.ts';
import type { AuditLogEvent } from '../auth/audit_log_schema.ts';
import { create_audit_emitter } from '../auth/audit_emitter.ts';
import type { AuditFactory } from '../server/app_backend.ts';
import {
	create_test_app,
	type SuiteAppOptions,
	type TestApp,
	type TestAccount
} from './test_app.ts';
import { check_db_invariants_after_suite } from './db_invariants.ts';
import { create_default_db_factory, type DbFactory } from './db.ts';
import { init_test_auth_schema } from './app_server.ts';
import { close_after_error } from './close_after_error.ts';
import {
	find_route_spec,
	pick_auth_principal,
	to_principal_headers,
	type AuthPrincipal
} from './integration_helpers.ts';
import {
	rpc_call,
	require_rpc_endpoint_path,
	resolve_rpc_endpoints_for_setup,
	type RpcEndpointsSuiteOption
} from './rpc_helpers.ts';
import type { Db } from '../db/db.ts';
import { account_session_revoke_all_action_spec } from '../auth/account_action_specs.ts';
import { create_sse_frame_reader } from './transports/sse_frame_reader.ts';

/** Config for a single SSE route under test. */
export interface SseRouteTestSpec {
	/** Full HTTP path of the SSE endpoint (e.g., `'/api/zap/subscribe'`). */
	path: string;
	/**
	 * Fire an event matching one of the declared `event_specs` that should
	 * reach the open stream. Called after the `: connected` comment is observed.
	 * The triggered frame must be a JSON-serializable `{method, params}` payload.
	 */
	trigger: (ctx: { test_app: TestApp; account: TestAccount }) => Promise<void>;
	/**
	 * Event specs to validate the triggered payload against. When omitted,
	 * the payload is only asserted to be well-formed `{method, params}`.
	 */
	event_specs?: Array<EventSpec>;
	/**
	 * Whether to assert the stream closes after `session_revoke_all`.
	 * Default `true`. Set `false` for endpoints whose registry no revocation
	 * reaches — neither joined to the backend's closer nor guarded (leaves a
	 * TODO to fix, rather than silently passing), and for a route opened by
	 * the keeper's daemon token or with no credential, which no session revoke
	 * closes — the test throws naming this option when such a route leaves it
	 * `true`.
	 */
	assert_closes_on_revoke?: boolean;
}

/** Options for `describe_sse_route_tests`. */
export interface SseRouteTestOptions {
	/** The session cookie's name. */
	session_cookie_name: string;
	/** Route spec factory — same shape as production. */
	create_route_specs: (ctx: AppServerContext) => Array<RouteSpec>;
	/** Optional overrides for `AppServerOptions`. */
	app_options?: SuiteAppOptions;
	/** Database factories to run tests against. Default: the default factory (`create_default_db_factory`) only. */
	db_factories?: Array<DbFactory>;
	/**
	 * Backend audit event callback — threaded to `create_test_app_server`.
	 * Use to wire a close-on-revoke guard for consumer SSE registries (e.g.
	 * `create_revocation_guard(create_sse_connection_closer(registry, role), log)`)
	 * so `session_revoke_all` closes the tested streams — not needed for a
	 * registry the route joined to `ctx.deps.connection_closer`, which the
	 * revoking handler closes itself.
	 */
	on_audit_event?: (event: AuditLogEvent) => void;
	/**
	 * RPC endpoint specs — required so the close-on-revoke assertion can
	 * dispatch `account_session_revoke_all` via RPC (there is no REST
	 * equivalent). Hard-fails via `require_rpc_endpoint_path` on setup.
	 *
	 * Accepts either an array (eager) or a factory
	 * `(ctx: AppServerContext) => Array<RpcEndpointSpec>` — the factory form
	 * is required when action handlers must close over the per-test
	 * `ctx.deps`. The factory must return the same
	 * endpoint `path` regardless of ctx — it is invoked once at setup with
	 * a stub ctx for path lookup and again per-test by `create_app_server`
	 * for live dispatch.
	 */
	rpc_endpoints: RpcEndpointsSuiteOption;
	/** SSE routes to exercise. */
	routes: Array<SseRouteTestSpec>;
}

/**
 * Validate a decoded SSE `data:` frame as a JSON-RPC-style `{method, params}` payload.
 */
const parse_and_validate_sse_payload = (
	frame: string,
	event_specs: Array<EventSpec> | undefined,
	route_path: string
): SseNotification => {
	const data_line = frame.split('\n').find((line) => line.startsWith('data: '));
	assert.ok(data_line, `${route_path}: no 'data:' line in frame: ${JSON.stringify(frame)}`);
	const json_str = data_line.slice('data: '.length);
	let payload: unknown;
	try {
		payload = JSON.parse(json_str);
	} catch (e) {
		throw new Error(`${route_path}: data frame not JSON: ${(e as Error).message} — ${json_str}`);
	}
	assert.ok(
		payload && typeof payload === 'object',
		`${route_path}: payload must be an object, got ${typeof payload}`
	);
	const notification = payload as Partial<SseNotification>;
	assert.strictEqual(
		typeof notification.method,
		'string',
		`${route_path}: payload.method must be a string`
	);
	assert.ok('params' in notification, `${route_path}: payload missing 'params'`);

	if (event_specs) {
		const spec = event_specs.find((s) => s.method === notification.method);
		assert.ok(
			spec,
			`${route_path}: no EventSpec declared for method '${
				notification.method
			}' (declared: ${event_specs.map((s) => s.method).join(', ')})`
		);
		const result = parse(spec.params, notification.params);
		if (!result.ok) {
			throw new Error(
				`${route_path}: params mismatch for method '${notification.method}': ${JSON.stringify(
					result.issues
				)}`
			);
		}
	}
	return notification as SseNotification;
};

/**
 * Run SSE route validation tests.
 *
 * For each route: opens an authenticated SSE connection, asserts the
 * connected comment, fires the trigger, validates the resulting payload,
 * then asserts close-on-revoke (unless opted out).
 *
 * @throws Error at setup time when `options.rpc_endpoints` is empty — the
 *   close-on-revoke assertion dispatches `account_session_revoke_all` via
 *   RPC. Hard-fails via `require_rpc_endpoint_path`.
 */
export const describe_sse_route_tests = (options: SseRouteTestOptions): void => {
	// Hard-fail early so consumers see a clear setup error instead of a
	// confusing test failure when `rpc_endpoints` is missing. Factory-form
	// callers are resolved with a stub ctx purely to extract the endpoint
	// path; real handlers run per-test via the top-level `rpc_endpoints` slot on `CreateTestAppOptions`.
	const rpc_endpoints_for_setup = resolve_rpc_endpoints_for_setup(
		options.rpc_endpoints,
		options.session_cookie_name
	);
	const rpc_path = require_rpc_endpoint_path(rpc_endpoints_for_setup);

	const factories = options.db_factories ?? [create_default_db_factory(init_test_auth_schema)];

	for (const factory of factories) {
		const describe_fn = factory.skip ? describe.skip : describe;
		describe_fn(`SSE validation (${factory.name})`, () => {
			for (const route_config of options.routes) {
				describe(`GET ${route_config.path}`, () => {
					let test_app: TestApp;
					let authed_account: TestAccount;
					let admin_account: TestAccount;
					let account: TestAccount;
					let db: Db;

					beforeAll(async () => {
						db = await factory.create();
						// Forward the consumer's listener through an `audit_factory`
						// body — the sugar was removed from `TestAppServerOptions`
						// to match the production `CreateAppBackendOptions` shape.
						const { on_audit_event } = options;
						const audit_factory: AuditFactory | undefined = on_audit_event
							? (params) => create_audit_emitter({ ...params, on_audit_event })
							: undefined;
						test_app = await create_test_app({
							session_cookie_name: options.session_cookie_name,
							create_route_specs: options.create_route_specs,
							db,
							rpc_endpoints: options.rpc_endpoints,
							app_options: options.app_options,
							audit_factory
						});
						authed_account = await test_app.create_account({
							username: 'sse_authed',
							roles: []
						});
						admin_account = await test_app.create_account({
							username: 'sse_admin',
							roles: [ROLE_ADMIN]
						});
					});

					// the app is built in `beforeAll`, outside any test, so it is checked
					// once the describe's tests are done, ahead of the cleanup
					// eslint-disable-next-line no-empty-pattern
					afterAll(async ({}, suite) => {
						// both closes run whatever came before; the first failure leads
						const close = async (): Promise<void> => {
							try {
								await test_app.cleanup();
							} catch (error) {
								return close_after_error(() => factory.close(db), error);
							}
							await factory.close(db);
						};
						try {
							await check_db_invariants_after_suite(suite, test_app);
						} catch (error) {
							return close_after_error(close, error);
						}
						await close();
					});

					test('opens, emits payload, closes on revoke', async () => {
						const spec = find_route_spec(test_app.route_specs, 'GET', route_config.path);
						assert.ok(spec, `no route spec for GET ${route_config.path}`);

						// one principal picks both the stream's credential and the account
						// whose sessions are revoked, so the revoke reaches the stream
						const principal = pick_sse_route_principal(
							`GET ${route_config.path}`,
							spec.auth,
							route_config.assert_closes_on_revoke !== false
						);
						account = to_principal_account(principal, test_app, authed_account, admin_account);
						const headers = to_principal_headers(
							principal,
							test_app,
							authed_account,
							admin_account
						);

						const res = await test_app.app.request(route_config.path, {
							method: 'GET',
							headers
						});
						assert.strictEqual(
							res.status,
							200,
							`expected 200 for ${route_config.path}, got ${res.status}`
						);
						assert.ok(
							res.headers.get('Content-Type')?.includes('text/event-stream'),
							`${route_config.path}: Content-Type must be text/event-stream`
						);
						assert.ok(res.body, `${route_config.path}: response has no body`);

						const reader = res.body.getReader();
						const sse = create_sse_frame_reader(reader);

						try {
							// 1. Connected comment — matches SSE_CONNECTED_COMMENT minus the trailing \n\n.
							const first = await sse.read_frame();
							assert.strictEqual(
								first + '\n\n',
								SSE_CONNECTED_COMMENT,
								`${route_config.path}: first frame must be the connected comment`
							);

							// 2. Trigger → first data frame.
							await route_config.trigger({ test_app, account });
							const data_frame = await sse.read_frame();
							parse_and_validate_sse_payload(
								data_frame,
								route_config.event_specs,
								route_config.path
							);

							// 3. Close-on-revoke.
							if (route_config.assert_closes_on_revoke !== false) {
								const revoke_res = await rpc_call({
									app: test_app.app,
									path: rpc_path,
									method: account_session_revoke_all_action_spec.method,
									headers: account.create_session_headers()
								});
								assert.ok(
									revoke_res.ok,
									`account_session_revoke_all RPC failed (status=${revoke_res.status}): ${
										revoke_res.ok ? '' : JSON.stringify(revoke_res.error)
									}`
								);
								const closed = await sse.wait_for_close(2000);
								assert.ok(
									closed,
									`${route_config.path}: stream did not close within 2s after session_revoke_all`
								);
							}
						} finally {
							await sse.cancel();
						}
					});
				});
			}
		});
	}
};

/**
 * The principal `describe_sse_route_tests` opens a route's stream as —
 * `pick_auth_principal`'s, except that a route admitting both the keeper's
 * daemon token and a session is opened with a session, since only a
 * session's revoke closes the stream.
 *
 * @param label - the route, for the error
 * @param auth - the route's auth
 * @param assert_closes_on_revoke - whether the test revokes the stream's sessions
 * @returns the principal
 * @throws Error when the revoke is asserted and the stream opens as the
 *   daemon token or with no credential, which no session revoke closes
 */
export const pick_sse_route_principal = (
	label: string,
	auth: RouteAuth,
	assert_closes_on_revoke: boolean
): AuthPrincipal => {
	let principal = pick_auth_principal(auth);
	if (principal === 'daemon_token' && auth.credential_types?.includes('session')) {
		const { credential_types: _, ...session_auth } = auth;
		principal = pick_auth_principal(session_auth);
	}
	if (assert_closes_on_revoke && (principal === 'daemon_token' || principal === 'public')) {
		throw new Error(
			`${label}: the stream opens as the ${principal} principal, which no session revoke ` +
				'can close — set `assert_closes_on_revoke: false`'
		);
	}
	return principal;
};

/**
 * The `TestAccount` a principal calls as, so the test revokes the sessions of
 * the account whose credential opened the stream. The keeper's principals,
 * and `'public'`, map to the bootstrapped account.
 */
const to_principal_account = (
	principal: AuthPrincipal,
	test_app: TestApp,
	authed_account: TestAccount,
	admin_account: TestAccount
): TestAccount => {
	switch (principal) {
		case 'admin':
			return admin_account;
		case 'authed':
			return authed_account;
		case 'public':
		case 'daemon_token':
		case 'keeper':
			return bootstrap_as_account(test_app);
	}
};

/**
 * Treat the bootstrapped `TestApp` account as a `TestAccount` for revocation.
 */
const bootstrap_as_account = (test_app: TestApp): TestAccount => ({
	account: test_app.backend.account,
	actor: test_app.backend.actor,
	session_cookie: test_app.backend.session_cookie,
	api_token: test_app.backend.api_token,
	create_session_headers: test_app.create_session_headers,
	create_bearer_headers: test_app.create_bearer_headers
});
