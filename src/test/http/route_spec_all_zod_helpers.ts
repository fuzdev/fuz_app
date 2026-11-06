/**
 * An all-Zod `RouteSpec` using every schema field (`params`, `query`,
 * `input`, `output`) and a 404 error definition plus a non-strict-input route, a `GET`
 * whose query preprocesses and transforms, a `z.null()`-input `POST`, a
 * coercing and transforming input, a `GET` whose params transform, and a
 * middleware declaring an error definition, and what they answer: the surface and a set
 * of exchanges (status, body text, `log.error` calls). The handlers echo the
 * parsed values, so the exchanges pin parsed against raw. Captured once into
 * `fixtures/surface/route_spec_all_zod.json`, which
 * `route_spec.all_zod.test.ts` holds the live answer to byte for byte, so a
 * change to how route schemas are read moves nothing for a Zod spec.
 *
 * @module
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import {
	apply_route_specs,
	define_route,
	get_route_input,
	get_route_params,
	get_route_query
} from '#lib/http/route_spec.ts';
import { route_fail, route_ok, route_raw, type RouteRaw } from '#lib/http/route_result.ts';
import { generate_app_surface, type AppSurface } from '#lib/http/surface.ts';
import type { MiddlewareSpec } from '#lib/http/middleware_spec.ts';
import { fuz_auth_guard_resolver } from '#lib/auth/auth_guard_resolver.ts';
import { Uuid } from '#lib/primitive_schemas.ts';
import { rest_error } from '#lib/http/error_schemas.ts';
import { create_dev_route_error_check } from '#lib/http/dev_route_error_check.ts';
import { resolve_app_route_error_maps } from '#lib/http/route_errors.ts';
import { create_stub_db } from '#lib/testing/stubs.ts';

const ThingParams = z.strictObject({ thing_id: Uuid });
const ThingQuery = z.strictObject({ mode: z.enum(['a', 'b']) });
const ThingInput = z.strictObject({ name: z.string().min(1) });
const ThingOutput = z.strictObject({ id: Uuid, name: z.string(), mode: z.enum(['a', 'b']) });
// an error is a definition, never a Zod schema
const THING_NOT_FOUND = rest_error(404, 'thing_not_found');

// a JSON answer the route did not declare, with the bytes and type `c.json` writes
const json_raw = (body: unknown, status: number): RouteRaw =>
	route_raw(
		new Response(JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json' }
		})
	);

const thing_route = define_route({
	method: 'POST',
	path: '/things/:thing_id',
	auth: { account: 'none', actor: 'none' },
	description: 'Renames a thing.',
	params: ThingParams,
	query: ThingQuery,
	input: ThingInput,
	output: ThingOutput,
	errors: [THING_NOT_FOUND],
	handler: (c) => {
		const { thing_id } = get_route_params(c, ThingParams);
		const { mode } = get_route_query(c, ThingQuery);
		const { name } = get_route_input(c, ThingInput);
		if (name === 'missing') return route_fail(THING_NOT_FOUND);
		// deliberate violations, built raw
		if (name === 'wrong_404') return json_raw({ error: 'something_else' }, 404);
		if (name === 'wrong_output') return json_raw({ id: thing_id, name: 5, mode }, 200);
		return route_ok({ id: thing_id, name, mode });
	}
});

const loose_route = define_route({
	method: 'POST',
	path: '/loose',
	auth: { account: 'none', actor: 'none' },
	description: 'Takes a loose body.',
	input: z.object({ x: z.string() }),
	output: z.null(),
	handler: () => route_ok(null)
});

// a strict integer spelling with a default, as `http/db_routes.ts` reads `offset` / `limit`
const query_int = (bounds: z.ZodNumber, fallback: number) =>
	z.preprocess(
		(v) =>
			v === undefined
				? undefined
				: typeof v === 'string' && /^[+-]?\d+$/.test(v)
					? Number(v)
					: Number.NaN,
		bounds.default(fallback)
	);

const ThingViewQuery = z.strictObject({
	limit: query_int(z.number().int().min(1).max(10), 5),
	tag: z
		.string()
		.transform((v) => v.toUpperCase())
		.optional()
});

const view_route = define_route({
	method: 'GET',
	path: '/things/:thing_id',
	auth: { account: 'none', actor: 'none' },
	description: 'Views a thing.',
	params: ThingParams,
	query: ThingViewQuery,
	input: z.null(),
	output: z.strictObject({ id: Uuid, limit: z.number().int(), tag: z.string().nullable() }),
	handler: (c) => {
		const { thing_id } = get_route_params(c, ThingParams);
		const { limit, tag } = get_route_query(c, ThingViewQuery);
		return route_ok({ id: thing_id, limit, tag: tag ?? null });
	}
});

const touch_route = define_route({
	method: 'POST',
	path: '/things/:thing_id/touch',
	auth: { account: 'none', actor: 'none' },
	description: 'Touches a thing.',
	params: ThingParams,
	input: z.null(),
	output: z.strictObject({ id: Uuid, touched: z.literal(true) }),
	handler: (c) => {
		const { thing_id } = get_route_params(c, ThingParams);
		return route_ok({ id: thing_id, touched: true });
	}
});

const CountInput = z.strictObject({
	count: z.coerce.number().int(),
	label: z.string().transform((v) => v.toUpperCase())
});

const count_route = define_route({
	method: 'POST',
	path: '/counts',
	auth: { account: 'none', actor: 'none' },
	description: 'Counts a thing.',
	input: CountInput,
	output: z.strictObject({ count: z.number().int(), label: z.string() }),
	handler: (c) => {
		const { count, label } = get_route_input(c, CountInput);
		return route_ok({ count, label });
	}
});

const TagParams = z.strictObject({ tag: z.string().transform((v) => v.toUpperCase()) });

const tag_route = define_route({
	method: 'GET',
	path: '/tags/:tag',
	auth: { account: 'none', actor: 'none' },
	description: 'Views a tag.',
	params: TagParams,
	input: z.null(),
	output: z.strictObject({ tag: z.string() }),
	handler: (c) => {
		const { tag } = get_route_params(c, TagParams);
		return route_ok({ tag });
	}
});

const ROUTES = [thing_route, loose_route, view_route, touch_route, count_route, tag_route];

const middleware: MiddlewareSpec = {
	name: 'thing_gate',
	path: '/things/*',
	handler: async (_c, next) => {
		await next();
	},
	errors: [rest_error(403, 'thing_gate_refused')]
};

/** One request the probe sends. */
interface ProbeRequest {
	label: string;
	/** `POST` with a JSON content type when omitted. */
	method?: 'GET';
	url: string;
	body?: string;
}

/** What the app answered one request with. */
export interface ProbeExchange {
	label: string;
	status: number;
	body: string;
	/** Each `log.error` call, its arguments as JSON. */
	logs: Array<string>;
}

const THING = '/things/0b7d4f0e-3f7c-4a51-9b8e-6c1f2a3d4e5f';

const REQUESTS: Array<ProbeRequest> = [
	{ label: 'valid', url: `${THING}?mode=a`, body: '{"name":"n"}' },
	{ label: 'invalid params', url: '/things/not-a-uuid?mode=a', body: '{"name":"n"}' },
	{ label: 'invalid query', url: `${THING}?mode=c`, body: '{"name":"n"}' },
	{ label: 'missing query', url: THING, body: '{"name":"n"}' },
	{ label: 'unknown query key', url: `${THING}?mode=a&extra=1`, body: '{"name":"n"}' },
	{ label: 'invalid input', url: `${THING}?mode=a`, body: '{"name":5,"extra":null}' },
	{ label: 'empty name', url: `${THING}?mode=a`, body: '{"name":""}' },
	{ label: 'invalid json', url: `${THING}?mode=a`, body: '{' },
	{ label: 'non-object json', url: `${THING}?mode=a`, body: '[]' },
	{ label: 'declared 404', url: `${THING}?mode=a`, body: '{"name":"missing"}' },
	{ label: 'undeclared 404 body', url: `${THING}?mode=a`, body: '{"name":"wrong_404"}' },
	{ label: 'output mismatch', url: `${THING}?mode=b`, body: '{"name":"wrong_output"}' },
	{ label: 'loose input', url: '/loose', body: '{"x":"y","z":1}' },
	{ label: 'get', method: 'GET', url: `${THING}?limit=3&tag=x` },
	{ label: 'get defaulted query', method: 'GET', url: THING },
	{ label: 'get signed limit', method: 'GET', url: `${THING}?limit=%2B7` },
	{ label: 'get limit not an integer', method: 'GET', url: `${THING}?limit=1.5` },
	{ label: 'get limit spelled loosely', method: 'GET', url: `${THING}?limit=%201` },
	{ label: 'get limit out of range', method: 'GET', url: `${THING}?limit=11` },
	{ label: 'get empty tag', method: 'GET', url: `${THING}?tag=` },
	{ label: 'get unknown query key', method: 'GET', url: `${THING}?extra=1` },
	{ label: 'get invalid params', method: 'GET', url: '/things/not-a-uuid' },
	{ label: 'get transformed params', method: 'GET', url: '/tags/ab' },
	{ label: 'null input, no body', url: `${THING}/touch`, body: '' },
	{ label: 'null input, json null', url: `${THING}/touch`, body: 'null' },
	{ label: 'null input, an object body', url: `${THING}/touch`, body: '{"a":1}' },
	{ label: 'null input, invalid json', url: `${THING}/touch`, body: '{' },
	{ label: 'coerced input', url: '/counts', body: '{"count":"7","label":"ab"}' },
	{ label: 'coerced input, number', url: '/counts', body: '{"count":7.0,"label":"ab"}' },
	{ label: 'coerce refused', url: '/counts', body: '{"count":"x","label":"ab"}' },
	{ label: 'coerced empty string', url: '/counts', body: '{"count":"","label":""}' },
	{ label: 'transform refused', url: '/counts', body: '{"count":1,"label":5}' }
];

/** The surface of the probe's specs. */
export const probe_all_zod_surface = (): AppSurface =>
	generate_app_surface({ route_specs: ROUTES, middleware_specs: [middleware] });

/** Send each probe request to an app built from the probe's specs. */
export const probe_all_zod_exchanges = async (): Promise<Array<ProbeExchange>> => {
	const log = new Logger('test', { level: 'off' });
	let calls: Array<string> = [];
	log.error = (...args: Array<unknown>) => {
		calls.push(JSON.stringify(args));
	};
	const app = new Hono();
	// the DEV error check outermost, as `create_app_server` mounts it; the
	// middleware isn't mounted here, so the maps are the routes' own
	const check = create_dev_route_error_check({
		route_specs: ROUTES,
		route_error_maps: resolve_app_route_error_maps(ROUTES),
		log
	});
	if (check) app.use('*', check);
	apply_route_specs(app, ROUTES, fuz_auth_guard_resolver, log, create_stub_db());
	const exchanges: Array<ProbeExchange> = [];
	for (const { label, method, url, body } of REQUESTS) {
		calls = [];
		const res = await app.request(
			url,
			method === 'GET'
				? { method }
				: { method: 'POST', headers: { 'content-type': 'application/json' }, body }
		);
		exchanges.push({ label, status: res.status, body: await res.text(), logs: calls });
	}
	return exchanges;
};
