/**
 * Tests for `create_test_app_server` factory.
 *
 * @module
 */

import { test, assert, beforeAll, beforeEach, afterAll, describe } from 'vitest';
import { array, object, string, void as fuz_void } from '@fuzdev/fuz_schema/schema.ts';
import type { EventSpec } from '#lib/realtime/sse.ts';
import { create_stub_upgrade } from '#lib/testing/ws_round_trip.ts';

import type { RequestResponseActionSpec } from '#lib/actions/action_spec.ts';
import type { RpcAction } from '#lib/actions/action_types.ts';
import { ROLE_KEEPER } from '#lib/auth/role_schema.ts';
import { token_scope_full, token_scope_methods } from '#lib/auth/token_scope.ts';
import { create_health_route_spec } from '#lib/http/common_routes.ts';
import {
	APP_SERVER_RATE_LIMITER_KEYS,
	collect_config_diagnostics,
	create_app_server,
	type ConfigDiagnosticsInput
} from '#lib/server/app_server.ts';
import type { MiddlewareSpec } from '#lib/http/middleware_spec.ts';
import {
	create_test_app_server,
	create_loopback_app_server_options
} from '#lib/testing/app_server.ts';
import { create_test_app, type SuiteAppOptions } from '#lib/testing/test_app.ts';
import {
	create_test_app_surface_spec,
	type CreateTestAppSurfaceSpecOptions
} from '#lib/testing/stubs.ts';
import { auth_truncate_tables } from '#lib/testing/db.ts';
import { query_role_grant_find_active_for_actor } from '#lib/auth/role_grant_queries.ts';

import { default_db_factory } from '../db_fixture.ts';

const session_cookie_name = 'test_session';

let db: Awaited<ReturnType<typeof default_db_factory.create>>;

beforeAll(async () => {
	db = await default_db_factory.create();
});

beforeEach(async () => {
	for (const table of auth_truncate_tables) {
		await db.query(`TRUNCATE ${table} CASCADE`);
	}
});

afterAll(async () => {
	await default_db_factory.close(db);
});

test('creates a bootstrapped auth server', async () => {
	const server = await create_test_app_server({ db });

	// Account exists with default username
	assert.strictEqual(server.account.username, 'keeper');

	// API token has the expected prefix
	assert.ok(server.api_token.startsWith('secret_fuz_token_'));

	// Session cookie is signed (non-empty)
	assert.ok(server.session_cookie.length > 0);

	// DB is live — account exists
	const rows = await server.deps.db.query('SELECT id FROM account LIMIT 1');
	assert.isTrue(rows.length > 0);
});

test('custom username and roles are applied', async () => {
	const server = await create_test_app_server({
		db,
		username: 'admin',
		roles: [ROLE_KEEPER, 'admin']
	});

	assert.strictEqual(server.account.username, 'admin');

	const role_grants = await query_role_grant_find_active_for_actor(
		{ db: server.deps.db },
		server.actor.id
	);
	assert.strictEqual(role_grants.length, 2);
});

test('works with create_app_server', async () => {
	const test_server = await create_test_app_server({ db });

	const { app } = await create_app_server({
		...create_loopback_app_server_options(),
		backend: test_server,
		session_cookie_name,
		auth_cleanup: 'off',
		create_route_specs: () => [create_health_route_spec()]
	});

	const res = await app.request('/health');
	assert.strictEqual(res.status, 200);
	const body = await res.json();
	assert.strictEqual(body.status, 'ok');
});

test('the keeper and each created account carry their API token row id and scope', async () => {
	const test_app = await create_test_app({ session_cookie_name, db, create_route_specs: () => [] });
	const read_token = (id: string) =>
		db.query_one<{ account_id: string; scope: unknown }>(
			'SELECT account_id, scope FROM api_token WHERE id = $1',
			[id]
		);

	const keeper_row = await read_token(test_app.backend.api_token_id);
	assert.ok(keeper_row);
	assert.strictEqual(keeper_row.account_id, test_app.backend.account.id);
	assert.deepEqual(keeper_row.scope, token_scope_full());

	const scope = token_scope_methods(['account_verify']);
	const narrowed = await test_app.create_account({ api_token_scope: scope });
	const narrowed_row = await read_token(narrowed.api_token_id);
	assert.ok(narrowed_row);
	assert.strictEqual(narrowed_row.account_id, narrowed.account.id);
	assert.deepEqual(narrowed_row.scope, scope);
});

// --- create_test_app: top-level `rpc_endpoints` option (15g) ---------------

const widget_list_spec: RequestResponseActionSpec = {
	method: 'widget_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'none', actor: 'none' },
	side_effects: false,
	input: fuz_void,
	output: object({ items: array(string) }),
	async: true,
	description: 'List widgets'
};

const widget_actions: Array<RpcAction> = [
	{ spec: widget_list_spec, handler: () => ({ items: ['a'] }) }
];

test('create_test_app forwards top-level rpc_endpoints to create_app_server', async () => {
	const test_app = await create_test_app({
		session_cookie_name,
		db,
		create_route_specs: () => [],
		rpc_endpoints: [{ path: '/api/rpc', actions: widget_actions }]
	});
	try {
		assert.strictEqual(test_app.surface.rpc_endpoints.length, 1);
		assert.strictEqual(test_app.surface.rpc_endpoints[0]?.path, '/api/rpc');
		// the assembled server rides along, its lifted fields the same objects
		assert.strictEqual(test_app.server.app, test_app.app);
		assert.strictEqual(test_app.server.surface_spec, test_app.surface_spec);
	} finally {
		await test_app.cleanup();
	}
});

// The live server and the stub surface assemble through one function
// (`assemble_app_surface`), so for each option the two must produce the same
// surface — every field but the server's config diagnostics, which only the
// server adds.
const shared_surface_options = {
	session_cookie_name,
	create_route_specs: () => [create_health_route_spec()],
	rpc_endpoints: [{ path: '/api/rpc', actions: widget_actions }],
	bootstrap: { mode: 'surface_only' as const },
	// what `create_test_app` passes (`create_loopback_app_server_options`)
	env_schema: object({})
};

const post_route_spec: MiddlewareSpec = {
	name: 'post_route',
	path: '*',
	handler: async (_c, next) => next()
};
const added_layer: MiddlewareSpec = {
	name: 'added_layer',
	path: '/api/*',
	handler: async (_c, next) => next()
};

const create_null_rate_limiters = (): ConfigDiagnosticsInput['rate_limiters'] =>
	Object.fromEntries(
		APP_SERVER_RATE_LIMITER_KEYS.map((key) => [key, null])
	) as ConfigDiagnosticsInput['rate_limiters'];

/** The `AppServerOptions` both entry points take, keyed by what each case varies. */
type SurfaceCaseOptions = Pick<
	CreateTestAppSurfaceSpecOptions & SuiteAppOptions,
	| 'surface_route'
	| 'audit_log_sse'
	| 'post_route_middleware'
	| 'origin_carve_outs'
	| 'transform_middleware'
	| 'max_body_size'
	| 'host_gate'
	| 'event_specs'
	| 'ws_endpoints'
>;

/** One parity case: the shared options, and what only one entry point takes. */
interface SurfaceCase {
	options: SurfaceCaseOptions;
	/** `create_test_app`'s top-level options, passed to the stub surface too. */
	top?: Pick<CreateTestAppSurfaceSpecOptions, 'rpc_endpoints' | 'bootstrap'>;
	/** Passed to the stub surface alone — the server's list where the server reads it. */
	stub_only?: Pick<CreateTestAppSurfaceSpecOptions, 'allowed_origins'>;
}

const widget_event: EventSpec = {
	method: 'widget_changed',
	params: object({ id: string }),
	description: 'A widget changed',
	channel: 'widgets'
};

const surface_cases: Array<[label: string, surface_case: SurfaceCase]> = [
	['defaults', { options: {} }],
	['surface_route false', { options: { surface_route: false } }],
	['surface_route true', { options: { surface_route: true } }],
	['audit_log_sse true', { options: { audit_log_sse: true } }],
	['audit_log_sse with a role', { options: { audit_log_sse: { role: ROLE_KEEPER } } }],
	['post_route_middleware', { options: { post_route_middleware: [post_route_spec] } }],
	[
		'origin_carve_outs',
		{
			options: {
				origin_carve_outs: [{ path: '/hooks/*', reason: 'refuses browser callers itself' }]
			}
		}
	],
	[
		'transform_middleware',
		{ options: { transform_middleware: (specs) => [...specs, added_layer] } }
	],
	['max_body_size null', { options: { max_body_size: null } }],
	['host_gate false', { options: { host_gate: false } }],
	['event_specs', { options: { event_specs: [widget_event] } }],
	[
		'ws_endpoints taking the server origins',
		{
			options: { ws_endpoints: [{ path: '/api/ws' }] },
			stub_only: { allowed_origins: create_loopback_app_server_options().allowed_origins }
		}
	],
	[
		'ws_endpoints carrying their own origins',
		{
			options: {
				ws_endpoints: [
					{ path: '/api/ws', allowed_origins: create_loopback_app_server_options().allowed_origins }
				]
			}
		}
	],
	[
		'function-form rpc_endpoints',
		{
			options: {},
			top: { rpc_endpoints: () => [{ path: '/api/rpc', actions: widget_actions }] }
		}
	],
	[
		'bootstrap route_prefix',
		{ options: {}, top: { bootstrap: { mode: 'surface_only', route_prefix: '/api/auth' } } }
	],
	[
		'every option at once',
		{
			options: {
				surface_route: true,
				audit_log_sse: true,
				post_route_middleware: [post_route_spec],
				origin_carve_outs: [{ path: '/hooks/*', reason: 'refuses browser callers itself' }],
				transform_middleware: (specs) => [added_layer, ...specs],
				max_body_size: null,
				host_gate: false,
				event_specs: [widget_event],
				ws_endpoints: [{ path: '/api/ws' }]
			},
			stub_only: { allowed_origins: create_loopback_app_server_options().allowed_origins }
		}
	]
];

describe('create_test_app_surface_spec matches the live server surface', () => {
	test.each(surface_cases)('%s', async (_label, { options, top, stub_only }) => {
		const test_app = await create_test_app({
			...shared_surface_options,
			...top,
			db,
			app_options: {
				...options,
				...(options.ws_endpoints && { upgrade_websocket: create_stub_upgrade().upgradeWebSocket })
			}
		});
		try {
			const stub_surface = create_test_app_surface_spec({
				...shared_surface_options,
				...top,
				...options,
				...stub_only,
				// `create_test_app` always passes a `daemon_token_state`
				daemon_token: true
			}).surface;
			const live = test_app.surface;
			// the server appends its config diagnostics after the spec-level ones
			const config_diagnostics = collect_config_diagnostics({
				rate_limiter_mode: 'disabled_for_testing',
				// read only in the `'enforced'` mode
				rate_limiters: create_null_rate_limiters(),
				max_body_size: options.max_body_size
			});
			assert.deepStrictEqual(
				{ ...stub_surface, diagnostics: [...stub_surface.diagnostics, ...config_diagnostics] },
				live
			);
			// the cases reach what they vary
			assert.strictEqual(
				live.routes.some((r) => r.path === '/api/surface'),
				options.surface_route === true
			);
			assert.strictEqual(
				live.events.some((e) => e.channel === 'audit_log'),
				options.audit_log_sse !== undefined
			);
			assert.strictEqual(live.ws_endpoints.length, options.ws_endpoints?.length ?? 0);
			if (top?.bootstrap && 'route_prefix' in top.bootstrap) {
				assert.ok(live.routes.some((r) => r.path === '/api/auth/bootstrap'));
			}
		} finally {
			await test_app.cleanup();
		}
	});
});

// `backend.deps.audit` closes over the threaded `audit_log_config`.
// Emit-time validation behavior of the threaded config is covered by
// `auth/audit_log_queries.db.test.ts`'s `AuditEmitter.emit forwards config
// to query_audit_log` test, which uses the same threading path.
