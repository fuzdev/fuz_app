/**
 * The `{acting}` route queries, `@fuzdev/fuz_schema` `object`s over the twin
 * `ActingActor`: `GET /health`, `GET /tables` and
 * `DELETE /tables/:name/rows/:id` of `create_db_route_specs`, the bare-hash
 * `GET /api/facts/:hash`, `GET /api/surface`, and `GET /audit/stream`
 * (`AuditStreamQuery`).
 *
 * Each is held to the Zod query it replaced, `z.strictObject({acting})` over
 * the Zod `ActingActor`, on a corpus of query records built as Hono's
 * `c.req.query()` builds them (null-prototype): the same verdict, the same
 * output, and the same wire issues but for `message`. Their surface entries
 * are the Zod-era ones as JSON, captured in
 * `fixtures/surface/acting_query.json`, and through the route stack an
 * invalid query is answered with fuz_schema's issue messages under DEV.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { z } from 'zod';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { is, is_schema } from '@fuzdev/fuz_schema/schema.ts';

import {
	create_db_route_specs,
	type DbRouteDeps,
	type DbRouteOptions
} from '#lib/http/db_routes.ts';
import { create_serve_fact_route_spec } from '#lib/server/serve_fact_route.ts';
import { create_surface_route_spec } from '#lib/server/surface_route.ts';
import {
	AuditStreamQuery,
	create_audit_log_route_shape
} from '#lib/auth/audit_log_route_schema.ts';
import { ActingActor, input_schema_declares_acting } from '#lib/http/auth_shape.ts';
import { apply_route_specs, type RouteSpec } from '#lib/http/route_spec.ts';
import { generate_app_surface, type AppSurface } from '#lib/http/surface.ts';
import { fuz_auth_guard_resolver } from '#lib/auth/auth_guard_resolver.ts';
import { parse_any, to_wire_issues, WireIssue } from '#lib/schema_issues.ts';
import { Db } from '#lib/db/db.ts';

const log = new Logger('test', { level: 'off' });

const SURFACE_FIXTURE_PATH = new URL('../fixtures/surface/acting_query.json', import.meta.url);

/** The Zod query every route below declared before the port. */
const ZodActingQuery = z.strictObject({ acting: ActingActor });

const PORTED_ROUTE_KEYS = [
	'GET /health',
	'GET /tables',
	'DELETE /tables/:name/rows/:id',
	'GET /api/facts/:hash',
	'GET /api/surface',
	'GET /audit/stream'
] as const;

const DB_ROUTE_DEPS: DbRouteDeps = { audit: { emit_pool: async () => {} } };
const DB_ROUTE_OPTIONS: DbRouteOptions = {
	db_type: 'pglet-memory',
	db_name: 'test',
	browsable_tables: []
};

/** The routes whose query is `{acting}` alone, in `PORTED_ROUTE_KEYS` order. */
const create_acting_query_route_specs = (): Array<RouteSpec> => {
	const db_specs = create_db_route_specs(DB_ROUTE_DEPS, DB_ROUTE_OPTIONS);
	const by_key = new Map(db_specs.map((s) => [`${s.method} ${s.path}`, s]));
	return [
		by_key.get('GET /health')!,
		by_key.get('GET /tables')!,
		by_key.get('DELETE /tables/:name/rows/:id')!,
		create_serve_fact_route_spec({ facts_dir: '/facts', log }),
		create_surface_route_spec({
			surface: { diagnostics: [], middleware: [], routes: [] } as unknown as AppSurface
		}),
		{ ...create_audit_log_route_shape(), handler: () => new Response(null) }
	];
};

/** A query record as Hono's `c.req.query()` returns one: null-prototype, own keys only. */
const query_record = (entries: Record<string, unknown>): Record<string, unknown> => {
	const record: Record<string, unknown> = Object.create(null);
	for (const [k, v] of Object.entries(entries)) record[k] = v;
	return record;
};

const V1_LOWER = 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6';
const V4_LOWER = '3b241101-e2bb-4255-8caf-4136c566a962';
// every other character uppercased, the ids being ASCII
const mixed_case = (s: string): string =>
	s.replace(/./g, (c, i: number) => (i % 2 === 0 ? c.toUpperCase() : c));

const own_proto_key = (): Record<string, unknown> => {
	const record: Record<string, unknown> = Object.create(null);
	// an own key named `__proto__`, as Hono's parser writes one
	Object.defineProperty(record, '__proto__', {
		value: '1',
		enumerable: true,
		writable: true,
		configurable: true
	});
	return record;
};

/** The corpus, each input a value either library is handed as a query. */
const CORPUS: Array<[label: string, input: unknown]> = [
	['empty', query_record({})],
	['v1 lowercase', query_record({ acting: V1_LOWER })],
	['v1 uppercase', query_record({ acting: V1_LOWER.toUpperCase() })],
	['v1 mixed case', query_record({ acting: mixed_case(V1_LOWER) })],
	['v4 lowercase', query_record({ acting: V4_LOWER })],
	['v4 uppercase', query_record({ acting: V4_LOWER.toUpperCase() })],
	['v4 mixed case', query_record({ acting: mixed_case(V4_LOWER) })],
	['max lowercase', query_record({ acting: 'ffffffff-ffff-ffff-ffff-ffffffffffff' })],
	['max uppercase', query_record({ acting: 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF' })],
	['nil', query_record({ acting: '00000000-0000-0000-0000-000000000000' })],
	['version 9', query_record({ acting: 'f81d4fae-7dec-91d0-a765-00a0c91e6bf6' })],
	['version 0', query_record({ acting: 'f81d4fae-7dec-01d0-a765-00a0c91e6bf6' })],
	['bad variant', query_record({ acting: 'f81d4fae-7dec-11d0-c765-00a0c91e6bf6' })],
	['empty string', query_record({ acting: '' })],
	['not-a-uuid', query_record({ acting: 'not-a-uuid' })],
	['uuid with braces', query_record({ acting: `{${V1_LOWER}}` })],
	['one extra key', query_record({ x: '1' })],
	['one extra key beside a good acting', query_record({ acting: V1_LOWER, x: '1' })],
	['one extra key beside a bad acting', query_record({ acting: 'x', b: '' })],
	['several extra keys', query_record({ b: '', a: '', c: '1' })],
	['several extra keys beside a bad acting', query_record({ acting: 'x', b: '', a: '' })],
	['several extra keys beside a good acting', query_record({ b: '', acting: V4_LOWER, a: '' })],
	['an own __proto__ key', own_proto_key()],
	['an own __proto__ key beside acting', Object.assign(own_proto_key(), { acting: V1_LOWER })],
	['Acting', query_record({ Acting: V1_LOWER })],
	['ACTING beside acting', query_record({ acting: V1_LOWER, ACTING: V1_LOWER })],
	['array acting', query_record({ acting: [V1_LOWER] })],
	['number acting', query_record({ acting: 1 })],
	['null acting', query_record({ acting: null })],
	['undefined acting', query_record({ acting: undefined })],
	['object acting', query_record({ acting: { V1_LOWER } })],
	['plain-prototype record', { acting: V1_LOWER.toUpperCase() }],
	['string root', 'acting'],
	['array root', []],
	['null root', null],
	['undefined root', undefined],
	['number root', 1]
];

/** What a parse gave, in the terms both libraries share. */
const outcome_of = (schema: Parameters<typeof parse_any>[0], input: unknown): unknown => {
	const result = parse_any(schema, input);
	if (result.ok) {
		const value = result.value as Record<string, unknown>;
		// own keys and their values, `undefined` ones included; the prototype is pinned apart
		return { ok: true, entries: Object.entries(value) };
	}
	return {
		ok: false,
		issues: to_wire_issues(result.issues, input).map(({ message: _, ...rest }) => rest)
	};
};

describe('the ported `{acting}` queries', () => {
	const specs = create_acting_query_route_specs();

	test('are the routes named, in order', () => {
		assert.deepStrictEqual(
			specs.map((s) => `${s.method} ${s.path}`),
			[...PORTED_ROUTE_KEYS]
		);
	});

	test('are fuz_schema schemas the acting check still finds', () => {
		for (const spec of specs) {
			assert.ok(is_schema(spec.query), `${spec.method} ${spec.path}`);
			assert.ok(
				spec.query && input_schema_declares_acting(spec.query),
				`${spec.method} ${spec.path}`
			);
		}
		assert.strictEqual(specs.at(-1)!.query, AuditStreamQuery);
	});

	test('`GET /tables/:name` keeps its Zod query, which still declares acting', () => {
		const detail = create_db_route_specs(DB_ROUTE_DEPS, DB_ROUTE_OPTIONS).find(
			(s) => s.method === 'GET' && s.path === '/tables/:name'
		);
		assert.ok(detail?.query);
		assert.ok(!is_schema(detail.query));
		assert.ok(input_schema_declares_acting(detail.query));
	});

	test('register through `apply_route_specs`, the acting biconditional holding', () => {
		const db = new Db({
			client: {
				query: () => {
					throw new Error('the database was reached');
				}
			},
			transaction: () => {
				throw new Error('the database was reached');
			}
		});
		assert.doesNotThrow(() =>
			apply_route_specs(new Hono(), specs, fuz_auth_guard_resolver, log, db)
		);
	});

	describe('agree with the Zod query', () => {
		for (const spec of specs) {
			const key = `${spec.method} ${spec.path}`;
			test(key, () => {
				for (const [label, input] of CORPUS) {
					assert.deepStrictEqual(
						outcome_of(spec.query!, input),
						outcome_of(ZodActingQuery, input),
						`${key}: ${label}`
					);
				}
			});
		}
	});

	test('the corpus has both verdicts, and outputs acting lowercased', () => {
		const query = specs[0]!.query!;
		let ok = 0;
		let refused = 0;
		for (const [, input] of CORPUS) {
			const result = parse_any(query, input);
			if (result.ok) {
				ok++;
				const { acting } = result.value as { acting?: string };
				if (acting !== undefined) assert.strictEqual(acting, acting.toLowerCase());
			} else {
				refused++;
			}
		}
		assert.ok(ok >= 10, `${ok} accepted`);
		assert.ok(refused >= 20, `${refused} refused`);
	});

	// the one difference in the output: Zod builds a new plain object, fuz_schema
	// returns the record itself when no entry changed it (its own prototype) and a
	// plain copy when one did, so no reader of `validated_query` can tell but by
	// its prototype or identity
	test('the output is the record itself unless acting was lowercased', () => {
		const query = specs[0]!.query!;
		const lower = query_record({ acting: V1_LOWER });
		const kept = parse_any(query, lower);
		assert.ok(kept.ok);
		assert.strictEqual(kept.value, lower);
		const upper = query_record({ acting: V1_LOWER.toUpperCase() });
		const copied = parse_any(query, upper);
		assert.ok(copied.ok);
		assert.notStrictEqual(copied.value, upper);
		assert.strictEqual(Object.getPrototypeOf(copied.value), Object.prototype);
		const zod = parse_any(ZodActingQuery, lower);
		assert.ok(zod.ok);
		assert.notStrictEqual(zod.value, lower);
		assert.strictEqual(Object.getPrototypeOf(zod.value), Object.prototype);
	});
});

describe('the surface entries of the ported routes', () => {
	test('are the Zod-era ones as JSON, `description` now written last', () => {
		const surface = generate_app_surface({
			route_specs: create_acting_query_route_specs(),
			middleware_specs: []
		});
		assert.deepStrictEqual(surface.diagnostics, []);
		const expected = readFileSync(SURFACE_FIXTURE_PATH, 'utf8');
		assert.deepStrictEqual(surface.routes, JSON.parse(expected));
		// equal as JSON, not byte for byte: fuz_schema writes a node's keywords in
		// its own order, `type` first and `description` last, where Zod wrote
		// `description` first
		const written = JSON.stringify(surface.routes, null, '\t') + '\n';
		assert.notStrictEqual(written, expected);
		for (const route of surface.routes) {
			const query_schema = route.query_schema as { properties: { acting: object } };
			assert.deepStrictEqual(Object.keys(query_schema.properties.acting), [
				'type',
				'format',
				'pattern',
				'description'
			]);
		}
	});
});

describe('through the route stack, an invalid query', () => {
	const create_app = (): Hono => {
		const refuse = (): never => {
			throw new Error('the database was reached');
		};
		const db = new Db({ client: { query: refuse }, transaction: refuse });
		const app = new Hono();
		apply_route_specs(app, create_acting_query_route_specs(), fuz_auth_guard_resolver, log, db);
		return app;
	};

	// valid path params, so the query is what the route refuses
	const PATHS: Record<(typeof PORTED_ROUTE_KEYS)[number], string> = {
		'GET /health': '/health',
		'GET /tables': '/tables',
		'DELETE /tables/:name/rows/:id': '/tables/browse_test/rows/1',
		'GET /api/facts/:hash': `/api/facts/blake3:${'0'.repeat(64)}`,
		'GET /api/surface': '/api/surface',
		'GET /audit/stream': '/audit/stream'
	};

	const EXPECTED_ISSUES: Array<WireIssue> = [
		{
			kind: 'uuid',
			path: ['acting'],
			expected: 'uuid',
			received: 'string',
			message: 'acting: expected uuid, received string'
		},
		{
			kind: 'unknown_key',
			path: ['x'],
			expected: 'no unknown keys',
			received: 'string',
			message: 'x: expected no unknown keys, received string'
		}
	];

	for (const key of PORTED_ROUTE_KEYS) {
		test(`${key} answers fuz_schema's issues under DEV`, async () => {
			const method = key.split(' ')[0]!;
			const res = await create_app().request(`${PATHS[key]}?acting=not-a-uuid&x=1`, { method });
			assert.strictEqual(res.status, 400);
			const body = await res.json();
			assert.deepStrictEqual(body, { error: 'invalid_query_params', issues: EXPECTED_ISSUES });
			for (const issue of body.issues) assert.ok(is(WireIssue, issue));
		});
	}

	test('an own `__proto__` key is an unknown key', async () => {
		const res = await create_app().request('/api/surface?__proto__=1');
		assert.strictEqual(res.status, 400);
		assert.deepStrictEqual(await res.json(), {
			error: 'invalid_query_params',
			issues: [
				{
					kind: 'unknown_key',
					path: ['__proto__'],
					expected: 'no unknown keys',
					received: 'string',
					message: '__proto__: expected no unknown keys, received string'
				}
			]
		});
	});
});
