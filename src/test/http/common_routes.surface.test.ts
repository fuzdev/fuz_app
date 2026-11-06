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

	test('the routes are the Zod-era ones but for the declared move', () => {
		const expected = head.routes.map((r) => MOVES[`${r.method} ${r.path}`]?.(r) ?? r);
		assert.deepStrictEqual(surface.routes, expected);
	});

	test('the routes serialize to the capture key for key', () => {
		const expected = move_read_only(
			head.routes.map((r) => MOVES[`${r.method} ${r.path}`]?.(r) ?? r)
		);
		assert.strictEqual(JSON.stringify(surface.routes), JSON.stringify(expected));
	});

	test('every error schema is the capture', () => {
		assert.deepStrictEqual(
			surface.routes.map((r) => r.error_schemas),
			head.routes.map((r) => r.error_schemas)
		);
	});

	test('the diagnostics are the capture', () => {
		assert.deepStrictEqual(surface.diagnostics, head.diagnostics);
	});
});
