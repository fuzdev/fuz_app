/**
 * The surface of the spine's leaf routes — `/health`, `/ready`,
 * `/api/server/status`, `/api/surface`, the audit stream, and the two fact
 * routes — held to the Zod-era one captured in
 * `fixtures/surface/common_routes.json`. Equal as JSON apart from one declared
 * move, applied to the capture here: `/api/server/status`'s `uptime_ms` is a
 * non-negative integer, where the Zod one was any number. Key for key, each
 * `readOnly` annotation moves after its node's keywords, where
 * `to_json_schema` writes metadata (Zod wrote `.readonly()` first): a move of
 * key order alone, applied before the comparison of serializations.
 *
 * The error schemas are the capture's but for the moves of the error rules,
 * `ERROR_MOVES`: the derived 400 is the codes each route's slots derive — a
 * query's, the actor codes, a params' — and no body code on these `GET`s (it
 * was one enum of the four input codes, or the fact route's own params
 * literal); the derived 401 is `authentication_required` exactly (it was any
 * string); and `/ready`'s 503 is its two definitions, loose objects (it was a
 * strict object over an enum of the two codes).
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { readFileSync } from 'node:fs';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import {
	create_health_route_spec,
	create_ready_route_spec,
	create_server_status_route_spec
} from '#lib/http/common_routes.ts';
import { create_surface_route_spec } from '#lib/server/surface_route.ts';
import { create_audit_log_route_shape } from '#lib/auth/audit_log_route_schema.ts';
import {
	create_serve_cell_fact_route_spec,
	create_serve_fact_route_spec
} from '#lib/server/serve_fact_route.ts';
import { generate_app_surface, type AppSurfaceDiagnostic } from '#lib/http/surface.ts';
import type { RouteSpec } from '#lib/http/route_spec.ts';
import {
	REST_ACTOR_NOT_ON_ACCOUNT,
	REST_ACTOR_REQUIRED,
	REST_AUTHENTICATION_REQUIRED,
	REST_DB_UNREACHABLE,
	REST_INVALID_QUERY_PARAMS,
	REST_INVALID_ROUTE_PARAMS,
	REST_SCHEMA_DRIFT
} from '#lib/http/error_schemas.ts';
import { with_error_moves, type ErrorMove } from '../surface_test_helpers.ts';

const FIXTURE_PATH = new URL('../fixtures/surface/common_routes.json', import.meta.url);

interface SurfaceCapture {
	routes: Array<Record<string, any>>;
	diagnostics: Array<AppSurfaceDiagnostic>;
}

const capture_surface = () => {
	const handler: RouteSpec['handler'] = (c) => c.json(null);
	const log = new Logger('test', { level: 'off' });
	const route_specs: Array<RouteSpec> = [
		create_health_route_spec(),
		create_ready_route_spec({ expected: { schema_version: ['name'] } }),
		create_server_status_route_spec({ version: '0.0.0', get_uptime_ms: () => 0 }),
		create_surface_route_spec({
			surface: generate_app_surface({ route_specs: [], middleware_specs: [] })
		}),
		{ ...create_audit_log_route_shape(), handler },
		create_serve_cell_fact_route_spec({ facts_dir: '/facts', log }),
		create_serve_fact_route_spec({ facts_dir: '/facts', log })
	];
	return generate_app_surface({ route_specs, middleware_specs: [] });
};

// the declared moves of one route, by `METHOD path`
const MOVES: Record<string, (route: Record<string, any>) => Record<string, any>> = {
	'GET /api/server/status': (route) => {
		const { properties } = route.output_schema;
		assert.deepStrictEqual(properties.uptime_ms, { type: 'number' });
		return {
			...route,
			output_schema: {
				...route.output_schema,
				properties: { ...properties, uptime_ms: { type: 'integer', minimum: 0 } }
			}
		};
	}
};

const ANY_INPUT_400 = [
	'invalid_request_body',
	'invalid_json_body',
	'invalid_route_params',
	'invalid_query_params',
	'actor_required',
	'actor_not_on_account'
];
const AUTH_401: ErrorMove = { from: ['*'], to: [REST_AUTHENTICATION_REQUIRED] };
const ACTING_QUERY_400: ErrorMove = {
	from: ANY_INPUT_400,
	to: [REST_INVALID_QUERY_PARAMS, REST_ACTOR_REQUIRED, REST_ACTOR_NOT_ON_ACCOUNT]
};

// the declared moves of the error rules, by `METHOD path` and status
const ERROR_MOVES: Record<string, Record<number, ErrorMove>> = {
	'GET /ready': {
		503: { from: ['schema_drift', 'db_unreachable'], to: [REST_SCHEMA_DRIFT, REST_DB_UNREACHABLE] }
	},
	'GET /api/server/status': { 401: AUTH_401 },
	'GET /api/surface': { 400: ACTING_QUERY_400, 401: AUTH_401 },
	'GET /audit/stream': { 400: ACTING_QUERY_400, 401: AUTH_401 },
	'GET /api/facts/:hash': {
		400: {
			from: ['invalid_route_params'],
			to: [
				REST_INVALID_ROUTE_PARAMS,
				REST_INVALID_QUERY_PARAMS,
				REST_ACTOR_REQUIRED,
				REST_ACTOR_NOT_ON_ACCOUNT
			]
		},
		401: AUTH_401
	}
};

/** A captured route with every declared move applied: its own, then the error rules'. */
const moved = (r: Record<string, any>): Record<string, any> => {
	const key = `${r.method} ${r.path}`;
	return with_error_moves(MOVES[key]?.(r) ?? r, ERROR_MOVES[key]);
};

/** The capture with each `readOnly` key last in its node, where fuz_schema writes it. */
const move_read_only = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(move_read_only);
	if (value === null || typeof value !== 'object') return value;
	const { readOnly, ...rest } = value as Record<string, unknown>;
	const moved = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, move_read_only(v)]));
	return readOnly === undefined ? moved : { ...moved, readOnly };
};

describe('common routes surface', () => {
	const head: SurfaceCapture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
	const surface = capture_surface();

	test('the capture is of every leaf route', () => {
		assert.deepStrictEqual(
			head.routes.map((r) => `${r.method} ${r.path}`),
			[
				'GET /health',
				'GET /ready',
				'GET /api/server/status',
				'GET /api/surface',
				'GET /audit/stream',
				'GET /api/cells/:cell_id/facts/:hash',
				'GET /api/facts/:hash'
			]
		);
	});

	test('the routes are the Zod-era ones but for the declared moves', () => {
		assert.deepStrictEqual(surface.routes, head.routes.map(moved));
	});

	test('the routes serialize to the capture key for key', () => {
		const expected = move_read_only(head.routes.map(moved));
		assert.strictEqual(JSON.stringify(surface.routes), JSON.stringify(expected));
	});

	test("every error schema is the capture's but for the error rules' moves", () => {
		assert.deepStrictEqual(
			surface.routes.map((r) => r.error_schemas),
			head.routes.map(
				(r) => with_error_moves(r, ERROR_MOVES[`${r.method} ${r.path}`]).error_schemas
			)
		);
	});

	test('the diagnostics are the capture', () => {
		assert.deepStrictEqual(surface.diagnostics, head.diagnostics);
	});
});
