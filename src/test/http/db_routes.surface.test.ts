/**
 * The surface of `create_db_route_specs` — `GET /health`, `GET /tables`,
 * `GET /tables/:name`, and `DELETE /tables/:name/rows/:id` — held to the
 * one captured in `fixtures/surface/db_routes.json`. Equal as JSON apart from
 * the declared moves, applied to the capture here:
 *
 * - the counts and positions the routes answer with (`row_count`, `total`,
 *   `offset`, `limit`) are non-negative integers, where the captured ones
 *   were any number;
 * - `GET /tables/:name`'s paging params, `offset` and `limit`, are strings of
 *   the pattern `^[+-]?\d+$`, their bounds in the description, where the
 *   captured ones were the integers the preprocess made of them: the steps after the
 *   `transform` read a number JSON Schema can't say the string becomes;
 * - so the diagnostics gain one `info` for that query, which names the step
 *   JSON Schema can't say.
 *
 * The error schemas are the capture's, the routes' error rules the ones it
 * was captured under, but for `GET /health`'s 503, which declares the fields
 * its body carries beside the code, `connected: false` and `type`, where the
 * capture declared the code alone.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { readFileSync } from 'node:fs';

import {
	create_db_route_specs,
	DB_TABLE_ROWS_LIMIT_MAX,
	type DbRouteDeps
} from '#lib/http/db_routes.ts';
import { generate_app_surface, type AppSurfaceDiagnostic } from '#lib/http/surface.ts';
import { REST_DATABASE_CONNECTION_FAILED } from '#lib/http/error_schemas.ts';

import { with_error_moves } from '../surface_test_helpers.ts';

const FIXTURE_PATH = new URL('../fixtures/surface/db_routes.json', import.meta.url);

interface SurfaceCapture {
	routes: Array<Record<string, any>>;
	diagnostics: Array<AppSurfaceDiagnostic>;
}

const DB_ROUTE_DEPS: DbRouteDeps = { audit: { emit_pool: async () => {} } };

const capture_surface = () =>
	generate_app_surface({
		route_specs: create_db_route_specs(DB_ROUTE_DEPS, {
			db_type: 'pglet-memory',
			db_name: 'test',
			browsable_tables: []
		}),
		middleware_specs: []
	});

const COUNT = { type: 'integer', minimum: 0 };

/** The capture's `{type: 'number'}` at each of `keys` of `properties`, moved to `COUNT`. */
const with_counts = (
	properties: Record<string, unknown>,
	keys: ReadonlyArray<string>
): Record<string, unknown> => {
	const out = { ...properties };
	for (const key of keys) {
		assert.deepStrictEqual(out[key], { type: 'number' }, key);
		out[key] = COUNT;
	}
	return out;
};

/** A paging param as the surface writes it: the pattern, and its bounds in the description. */
const query_int_node = (min: number, max: number) => ({
	type: 'string',
	pattern: '^[+-]?\\d+$',
	description: `an integer from ${min} to ${max}, as decimal digits with an optional sign`
});

// the declared moves of one route, by `METHOD path`
const MOVES: Record<string, (route: Record<string, any>) => Record<string, any>> = {
	'GET /health': (route) =>
		with_error_moves(route, {
			503: { from: ['database_connection_failed'], to: [REST_DATABASE_CONNECTION_FAILED] }
		}),
	'GET /tables': (route) => {
		const { tables } = route.output_schema.properties;
		return {
			...route,
			output_schema: {
				...route.output_schema,
				properties: {
					tables: {
						...tables,
						items: {
							...tables.items,
							properties: with_counts(tables.items.properties, ['row_count'])
						}
					}
				}
			}
		};
	},
	'GET /tables/:name': (route) => {
		const { properties } = route.query_schema;
		assert.deepStrictEqual(properties.offset, {
			type: 'integer',
			minimum: 0,
			maximum: Number.MAX_SAFE_INTEGER
		});
		assert.deepStrictEqual(properties.limit, {
			type: 'integer',
			minimum: 1,
			maximum: DB_TABLE_ROWS_LIMIT_MAX
		});
		return {
			...route,
			query_schema: {
				...route.query_schema,
				properties: {
					...properties,
					offset: query_int_node(0, Number.MAX_SAFE_INTEGER),
					limit: query_int_node(1, DB_TABLE_ROWS_LIMIT_MAX)
				}
			},
			output_schema: {
				...route.output_schema,
				properties: with_counts(route.output_schema.properties, ['total', 'offset', 'limit'])
			}
		};
	}
};

const moved = (r: Record<string, any>): Record<string, any> =>
	MOVES[`${r.method} ${r.path}`]?.(r) ?? r;

describe('db routes surface', () => {
	const head: SurfaceCapture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
	const surface = capture_surface();

	test('the capture is of every db route', () => {
		assert.deepStrictEqual(
			head.routes.map((r) => `${r.method} ${r.path}`),
			['GET /health', 'GET /tables', 'GET /tables/:name', 'DELETE /tables/:name/rows/:id']
		);
	});

	test('the routes are the captured ones but for the declared moves', () => {
		assert.deepStrictEqual(surface.routes, head.routes.map(moved));
	});

	test('the diagnostics are the capture with the paging query noted', () => {
		assert.deepStrictEqual(head.diagnostics, []);
		assert.deepStrictEqual(surface.diagnostics, [
			{
				level: 'info',
				category: 'schema',
				message:
					'Part of the schema has no JSON Schema form and is left out or written as {} there: ' +
					'cannot express `safe_integer` at #/properties/offset: ' +
					'it reads the output of a transform, which is not known',
				source: 'GET /tables/:name query'
			}
		]);
	});
});
