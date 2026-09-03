/**
 * The fact routes' declared 400 error schema.
 *
 * Both fact routes tighten their auto-derived 400 to the literal
 * `invalid_route_params` shape params validation emits. That body carries
 * `issues` only under DEV (`dev_only`), so the declared schema must admit a
 * body without it — a required `issues` makes the production body fail
 * `describe_round_trip_validation`, which parses declared error schemas
 * against live responses.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import {
	create_serve_fact_route_spec,
	create_serve_cell_fact_route_spec
} from '$lib/server/serve_fact_route.ts';
import type { AppDeps } from '$lib/auth/deps.ts';
import { ERROR_INVALID_ROUTE_PARAMS } from '$lib/http/error_schemas.ts';

// Neither factory reads `deps` at construction time (it exists on the
// options for symmetry with sibling route factories), so a bare stub is
// enough to reach the declared error schemas.
const deps = {} as AppDeps;
const log = new Logger('test', { level: 'off' });

const route_400_schemas = [
	['GET /api/cells/:cell_id/facts/:hash', create_serve_cell_fact_route_spec],
	['GET /api/facts/:hash', create_serve_fact_route_spec]
] as const;

describe('fact route 400 error schema', () => {
	for (const [label, create] of route_400_schemas) {
		describe(label, () => {
			const schema = create({ deps, facts_dir: '/tmp/facts', log }).errors?.[400];

			test('declares a 400 schema', () => {
				assert.ok(schema);
			});

			test('accepts the production body, which omits issues', () => {
				assert.ok(schema!.safeParse({ error: ERROR_INVALID_ROUTE_PARAMS }).success);
			});

			test('accepts the DEV body, which carries issues', () => {
				assert.ok(
					schema!.safeParse({
						error: ERROR_INVALID_ROUTE_PARAMS,
						issues: [{ code: 'invalid_format', path: ['hash'] }]
					}).success
				);
			});

			test('still refuses a different error literal', () => {
				assert.ok(!schema!.safeParse({ error: 'unauthenticated' }).success);
			});
		});
	}
});
