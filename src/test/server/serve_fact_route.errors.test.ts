/**
 * The fact routes' declared 400 error schema.
 *
 * Both fact routes declare no errors of their own: their 400 is what their
 * slots derive (`resolve_route_errors`) — the `invalid_route_params` params
 * validation emits, and on the bare-hash route the query and actor codes —
 * and never a body code, as neither reads a body. The params body carries
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
} from '#lib/server/serve_fact_route.ts';
import {
	ERROR_INVALID_JSON_BODY,
	ERROR_INVALID_REQUEST_BODY,
	ERROR_INVALID_ROUTE_PARAMS
} from '#lib/http/error_schemas.ts';
import { resolve_route_errors } from '#lib/http/schema_helpers.ts';
import { parse_any } from '#lib/schema_issues.ts';

const log = new Logger('test', { level: 'off' });

const route_400_schemas = [
	['GET /api/cells/:cell_id/facts/:hash', create_serve_cell_fact_route_spec],
	['GET /api/facts/:hash', create_serve_fact_route_spec]
] as const;

describe('fact route 400 error schema', () => {
	for (const [label, create] of route_400_schemas) {
		describe(label, () => {
			const spec = create({ facts_dir: '/tmp/facts', log });
			const schema = resolve_route_errors(spec).schemas[400];

			test('declares a 400 schema', () => {
				assert.ok(schema);
			});

			test('accepts the production body, which omits issues', () => {
				assert.ok(parse_any(schema!, { error: ERROR_INVALID_ROUTE_PARAMS }).ok);
			});

			test('accepts the DEV body, which carries issues', () => {
				assert.ok(
					parse_any(schema!, {
						error: ERROR_INVALID_ROUTE_PARAMS,
						issues: [
							{
								kind: 'regex',
								path: ['hash'],
								expected: '/^[0-9a-f]{64}$/',
								received: 'string',
								message: 'Invalid string: must match pattern /^[0-9a-f]{64}$/'
							}
						]
					}).ok
				);
			});

			test("refuses a DEV body whose issues are in a library's own shape", () => {
				assert.ok(
					!parse_any(schema!, {
						error: ERROR_INVALID_ROUTE_PARAMS,
						issues: [{ code: 'invalid_format', path: ['hash'] }]
					}).ok
				);
			});

			test('still refuses a different error literal, a body code among them', () => {
				assert.ok(!parse_any(schema!, { error: 'unauthenticated' }).ok);
				assert.ok(!parse_any(schema!, { error: ERROR_INVALID_REQUEST_BODY }).ok);
				assert.ok(!parse_any(schema!, { error: ERROR_INVALID_JSON_BODY }).ok);
			});

			test('declares no errors of its own', () => {
				assert.strictEqual(spec.errors, undefined);
			});
		});
	}
});
