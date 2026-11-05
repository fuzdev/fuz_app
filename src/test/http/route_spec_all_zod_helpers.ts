/**
 * An all-Zod `RouteSpec` using every schema field (`params`, `query`,
 * `input`, `output`, a 404 error) plus a non-strict-input route and a
 * middleware declaring an error, and what they answer: the surface and a set
 * of exchanges (status, body text, `log.error` calls). Captured once into
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
	get_route_input,
	get_route_params,
	get_route_query,
	type RouteSpec
} from '#lib/http/route_spec.ts';
import { generate_app_surface, type AppSurface } from '#lib/http/surface.ts';
import type { MiddlewareSpec } from '#lib/http/middleware_spec.ts';
import { fuz_auth_guard_resolver } from '#lib/auth/auth_guard_resolver.ts';
import { Uuid } from '#lib/primitive_schemas.ts';
import { create_stub_db } from '#lib/testing/stubs.ts';

const ThingParams = z.strictObject({ thing_id: Uuid });
const ThingQuery = z.strictObject({ mode: z.enum(['a', 'b']) });
const ThingInput = z.strictObject({ name: z.string().min(1) });
const ThingOutput = z.strictObject({ id: Uuid, name: z.string(), mode: z.enum(['a', 'b']) });
const ThingNotFound = z.looseObject({ error: z.literal('thing_not_found') });

const thing_route: RouteSpec = {
	method: 'POST',
	path: '/things/:thing_id',
	auth: { account: 'none', actor: 'none' },
	description: 'Renames a thing.',
	params: ThingParams,
	query: ThingQuery,
	input: ThingInput,
	output: ThingOutput,
	errors: { 404: ThingNotFound },
	handler: (c) => {
		const { thing_id } = get_route_params(c, ThingParams);
		const { mode } = get_route_query(c, ThingQuery);
		const { name } = get_route_input(c, ThingInput);
		if (name === 'missing') return c.json({ error: 'thing_not_found' }, 404);
		if (name === 'wrong_404') return c.json({ error: 'something_else' }, 404);
		if (name === 'wrong_output') return c.json({ id: thing_id, name: 5, mode }, 200);
		return c.json({ id: thing_id, name, mode });
	}
};

const loose_route: RouteSpec = {
	method: 'POST',
	path: '/loose',
	auth: { account: 'none', actor: 'none' },
	description: 'Takes a loose body.',
	input: z.object({ x: z.string() }),
	output: z.null(),
	handler: (c) => c.json(null)
};

const middleware: MiddlewareSpec = {
	name: 'thing_gate',
	path: '/things/*',
	handler: async (_c, next) => {
		await next();
	},
	errors: { 403: z.looseObject({ error: z.literal('thing_gate_refused') }) }
};

/** One request the probe sends. */
interface ProbeRequest {
	label: string;
	url: string;
	body: string;
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
	{ label: 'loose input', url: '/loose', body: '{"x":"y","z":1}' }
];

/** The surface of the probe's specs. */
export const probe_all_zod_surface = (): AppSurface =>
	generate_app_surface({ route_specs: [thing_route, loose_route], middleware_specs: [middleware] });

/** Send each probe request to an app built from the probe's specs. */
export const probe_all_zod_exchanges = async (): Promise<Array<ProbeExchange>> => {
	const log = new Logger('test', { level: 'off' });
	let calls: Array<string> = [];
	log.error = (...args: Array<unknown>) => {
		calls.push(JSON.stringify(args));
	};
	const app = new Hono();
	apply_route_specs(
		app,
		[thing_route, loose_route],
		fuz_auth_guard_resolver,
		log,
		create_stub_db()
	);
	const exchanges: Array<ProbeExchange> = [];
	for (const { label, url, body } of REQUESTS) {
		calls = [];
		const res = await app.request(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body
		});
		exchanges.push({ label, status: res.status, body: await res.text(), logs: calls });
	}
	return exchanges;
};
