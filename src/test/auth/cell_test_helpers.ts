/**
 * Shared scaffolding for the `cell_*` RPC integration suites.
 *
 * Provides a `create_route_specs` that mounts the full cell RPC surface
 * (cell / grant / field / item / audit) on `/api/rpc`, a `create_test_app`
 * wrapper that threads `cell_audit_events` through the audit factory so the
 * cell mutation events validate, and the call-site primitives (`call`,
 * `create_cell`; `error_reason` is in ./rpc_test_helpers.ts). The four-driver `describe_db`
 * carrying the cell migration namespaces is ../cell_db_fixture.ts.
 *
 * Not itself a test file — no `.test.` infix, so vitest skips it. Mirrors
 * `./role_grant_offer_test_helpers.ts`.
 *
 * @module
 */

import { assert } from 'vitest';
import { z } from 'zod';

import { create_session_config } from '#lib/auth/session_cookie.ts';
import {
	create_serve_fact_route_spec,
	create_serve_cell_fact_route_spec
} from '#lib/server/serve_fact_route.ts';
import { create_rpc_endpoint } from '#lib/actions/action_rpc.ts';
import { create_role_schema, ROLE_ADMIN, ROLE_KEEPER } from '#lib/auth/role_schema.ts';
import { create_audit_emitter } from '#lib/auth/audit_emitter.ts';
import { create_audit_log_config } from '#lib/auth/audit_log_schema.ts';
import { create_all_cell_actions } from '#lib/auth/all_cell_actions.ts';
import type { CellGrantCreateAuthorize } from '#lib/auth/cell_grant_actions.ts';
import type { CellActionDeps, CellCreateAuthorize } from '#lib/auth/cell_actions.ts';
import { cell_audit_events } from '#lib/auth/cell_audit_events.ts';
import {
	cell_create_action_spec,
	type CellCreateInput,
	type CellPath,
	type CellVisibility
} from '#lib/auth/cell_action_specs.ts';
import {
	cell_item_insert_action_spec,
	type CellItemPosition
} from '#lib/auth/cell_item_action_specs.ts';
import { fractional_indices_between } from '@fuzdev/fuz_util/fractional_index.ts';
import { create_test_app, type TestApp } from '#lib/testing/app_server.ts';
import { rpc_call_for_spec, type RpcCallResultForSpec } from '#lib/testing/rpc_helpers.ts';
import type { RequestResponseActionSpec } from '#lib/actions/action_spec.ts';
import type { AppServerContext } from '#lib/server/app_server_context.ts';
import type { AuditFactory } from '#lib/server/app_backend.ts';
import type { RouteSpec } from '#lib/http/route_spec.ts';
import type { Db } from '#lib/db/db.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';

/** Shared cookie config for the cell integration suites. */
export const session_options = create_session_config('test_session');

/** RPC mount path used across every cell integration suite. */
export const RPC_PATH = '/api/rpc';

/**
 * Role schema for the cell suites. `member` is a consumer role registered
 * so role-shaped `cell_grant` principals have a valid role to reference
 * (the unknown-role gate reads `roles.role_specs`).
 */
export const cell_test_roles = create_role_schema([{ name: 'member' }]);

/** Consumer role registered in `cell_test_roles`. */
export const ROLE_MEMBER = 'member';

/**
 * Default facts directory for the fact-serving routes — a path that is never
 * created. Embedded facts never touch it (`serve_fact_route` only reads disk
 * for external `file:` facts), but the route factory requires a path. A suite
 * that stores disk facts owns a temp dir and passes it as `facts_dir`; a stray
 * disk read or write against this default fails loudly instead of leaking a
 * directory.
 */
export const CELL_TEST_FACTS_DIR_UNUSED = '/nonexistent/fuz_app_cell_test_facts';

/** The optional cell seams a cell test app mounts. */
export interface CellTestAppOptions {
	/** The creation gate (default: open create, every policy write refused). */
	authorize_create?: CellCreateAuthorize;
	/** The grant gate (default: none past the spine's). */
	authorize_grant_create?: CellGrantCreateAuthorize;
	/** The per-kind data validator (default: pass-through). */
	validate_data?: CellActionDeps['validate_data'];
	/** Where disk facts live (default: `CELL_TEST_FACTS_DIR_UNUSED`). */
	facts_dir?: string;
}

/**
 * Mounts the full cell RPC surface on `/api/rpc` plus both fact-serving
 * REST routes: the cell-scoped per-reference read
 * (`GET /api/cells/:cell_id/facts/:hash`) and the admin-only bare-hash read
 * (`GET /api/facts/:hash`), with the seams `options` names.
 */
export const create_cell_route_specs =
	(options: CellTestAppOptions = {}) =>
	(ctx: AppServerContext): Array<RouteSpec> => {
		const {
			authorize_create,
			authorize_grant_create,
			validate_data,
			facts_dir = CELL_TEST_FACTS_DIR_UNUSED
		} = options;
		return [
			...create_rpc_endpoint({
				action_ip_rate_limiter: null,
				action_account_rate_limiter: null,
				path: RPC_PATH,
				actions: [
					...create_all_cell_actions(
						{ ...ctx.deps, authorize_create, authorize_grant_create, validate_data },
						{ roles: cell_test_roles }
					)
				],
				log: ctx.deps.log
			}),
			create_serve_cell_fact_route_spec({
				deps: ctx.deps,
				facts_dir,
				log: ctx.deps.log
			}),
			create_serve_fact_route_spec({
				deps: ctx.deps,
				facts_dir,
				log: ctx.deps.log
			})
		];
	};

/**
 * Default cell route specs — open create (no creation authorizer). Pass
 * `CellTestAppOptions` to `create_cell_route_specs` (or the third arg of
 * `create_cell_test_app`) to mount a seam.
 */
export const create_route_specs = create_cell_route_specs();

/**
 * Audit factory registering the cell event types so cell handlers'
 * `deps.audit.emit(...)` calls validate against the extended config
 * instead of tripping the unknown-event drift counter.
 */
const cell_audit_config = create_audit_log_config({ extra_events: cell_audit_events });
const cell_audit_factory: AuditFactory = ({ db, log }) =>
	create_audit_emitter({ db, log, audit_log_config: cell_audit_config });

/**
 * Create a cell test app bound to `get_db`, with cell events registered.
 * `options` mounts the seams (`CellTestAppOptions`) — `facts_dir` when the
 * suite serves disk facts from a temp dir it owns.
 */
export const create_cell_test_app = (
	get_db: () => Db,
	roles?: Array<string>,
	options?: CellTestAppOptions
): Promise<TestApp> =>
	create_test_app({
		session_options,
		create_route_specs: options ? create_cell_route_specs(options) : create_route_specs,
		audit_factory: cell_audit_factory,
		db: get_db(),
		roles: roles ?? []
	});

/**
 * Cell test app whose bootstrapped account holds `keeper` + `admin`.
 * Additional accounts via `test_app.create_account()` default to no roles.
 */
export const create_cell_admin_test_app = (get_db: () => Db): Promise<TestApp> =>
	create_cell_test_app(get_db, [ROLE_KEEPER, ROLE_ADMIN]);

/** `rpc_call_for_spec` with `app` + `path` pre-bound. */
export const call = <TSpec extends RequestResponseActionSpec>(
	test_app: TestApp,
	spec: TSpec,
	params: z.infer<TSpec['input']>,
	headers?: Record<string, string>
): Promise<RpcCallResultForSpec<TSpec>> =>
	rpc_call_for_spec({ app: test_app.app, path: RPC_PATH, spec, params, headers });

/**
 * Create a cell via the public RPC and return its id. Asserts the create
 * succeeded. `items`, when given, are attached as ordered children at
 * evenly-spaced fractional-index positions (parent created first).
 */
export const create_cell = async (
	test_app: TestApp,
	params: {
		data: CellCreateInput['data'];
		kind?: string;
		visibility?: CellVisibility;
		items?: Array<Uuid>;
		path?: CellPath;
		headers?: Record<string, string>;
	}
): Promise<{ id: Uuid }> => {
	const headers = params.headers ?? test_app.create_session_headers();
	const res = await call(
		test_app,
		cell_create_action_spec,
		{ kind: params.kind, data: params.data, visibility: params.visibility, path: params.path },
		headers
	);
	assert.ok(res.ok, `cell_create failed: ${res.ok ? '' : JSON.stringify(res.error)}`);
	const id = res.result.cell.id;
	if (params.items && params.items.length > 0) {
		const positions = fractional_indices_between(null, null, params.items.length);
		for (let i = 0; i < params.items.length; i++) {
			const insert_res = await call(
				test_app,
				cell_item_insert_action_spec,
				{
					parent_id: id,
					child_id: params.items[i]!,
					position: positions[i]! as CellItemPosition
				},
				headers
			);
			assert.ok(
				insert_res.ok,
				`cell_item_insert failed: ${insert_res.ok ? '' : JSON.stringify(insert_res.error)}`
			);
		}
	}
	return { id };
};
