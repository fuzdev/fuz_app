/**
 * Source census: a route module — every `src/lib` module that defines a
 * route handler, found by its call of `define_route` or `attach_route_handler`
 * rather than listed, so a new one is covered the day it lands — holds no
 * Hono and builds no response of its own.
 *
 * A handler receives a `RouteContext`, never the Hono context, and returns a
 * result the spine answers with after the commit. So a route module needs
 * nothing from `hono` or `@hono/*` — type-only imports included, where
 * `hono_free_modules.test.ts` follows value imports only — and spells none
 * of `new Response(`, `Response.json(`, `setCookie(`, or a `.header('Set-Cookie'`
 * call, the ways a module would build a response or write a cookie past the
 * spine. Whole comment lines are left out, so a module may document them.
 *
 * What it cannot see: a `Response` built in a helper module a route module
 * imports (its own module is not a route module unless it defines one), a
 * module that defines a handler under another name than the two factories,
 * and a consumer's own route modules. A consumer — fuz_forge mounts its own
 * REST routes — runs the same census over its `src/lib` by copying this file
 * and pointing `LIB_DIR` at it; it reads nothing of fuz_app's.
 *
 * @module
 */

import { test, assert, describe } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Absolute path to `src/lib`, resolved relative to this test. */
const LIB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../lib');

/** `src/lib` modules exempt from the census, each with its reason. */
const EXEMPT: ReadonlyMap<string, string> = new Map([
	// defines the two factories and builds every response the spine answers
	['http/route_spec.ts', 'the route spec system itself']
]);

/** A call of a route factory: what makes a module a route module. */
const DEFINES_ROUTE = /\b(?:define_route|attach_route_handler)\s*\(/;

/** What a route module may not spell, each named for the failure message. */
const REFUSED: ReadonlyArray<readonly [name: string, pattern: RegExp]> = [
	['an import from hono', /^\s*(?:import|export)\b[^;]*?\bfrom\s+['"](?:hono|@hono\/)[^'"]*['"]/m],
	['a bare import of hono', /^\s*import\s+['"](?:hono|@hono\/)[^'"]*['"]/m],
	['a dynamic import of hono', /\bimport\s*\(\s*['"](?:hono|@hono\/)/],
	['`new Response(`', /\bnew\s+Response\s*\(/],
	['`Response.json(`', /\bResponse\s*\.\s*json\s*\(/],
	['`setCookie(`', /\bsetCookie\s*\(/],
	['a `Set-Cookie` header write', /\.header\s*\(\s*(['"`])set-cookie\1/i]
];

/** Blank whole comment lines (`//`, ` * `, `/**`), so docs may name what code may not. */
const strip_comment_lines = (source: string): string =>
	source.replace(/^\s*(?:\/\/|\/\*\*?|\*).*$/gm, '');

const lib_modules = (): Array<string> =>
	readdirSync(LIB_DIR, { recursive: true, encoding: 'utf8' })
		.filter((name) => /\.(?:ts|svelte)$/.test(name))
		.sort();

/** The census's findings for one module's source. */
const census_route_module = (source: string): Array<string> => {
	const code = strip_comment_lines(source);
	return REFUSED.filter(([, pattern]) => pattern.test(code)).map(([name]) => name);
};

/** Whether a module's source defines a route handler. */
const is_route_module = (source: string): boolean =>
	DEFINES_ROUTE.test(strip_comment_lines(source));

const route_modules = lib_modules().filter(
	(module) => !EXEMPT.has(module) && is_route_module(readFileSync(join(LIB_DIR, module), 'utf8'))
);

describe('route modules hold no Hono and build no response', () => {
	test('the census finds the route modules', () => {
		// a positive control: the census would pass vacuously over no modules
		for (const known of [
			'actions/action_rpc.ts',
			'auth/account_routes.ts',
			'auth/audit_log_routes.ts',
			'auth/bootstrap_routes.ts',
			'auth/signup_routes.ts',
			'http/common_routes.ts',
			'http/db_routes.ts',
			'server/serve_fact_route.ts',
			'server/surface_route.ts'
		]) {
			assert.include(route_modules, known);
		}
	});

	for (const module of route_modules) {
		test(module, () => {
			assert.deepStrictEqual(census_route_module(readFileSync(join(LIB_DIR, module), 'utf8')), []);
		});
	}

	test('each refusal matches what it names, and comment lines are left out', () => {
		const cases: Array<[string, Array<string>]> = [
			["import type { Context } from 'hono';", ['an import from hono']],
			["import { streamSSE } from 'hono/streaming';", ['an import from hono']],
			["import { serve } from '@hono/node-server';", ['an import from hono']],
			["import {\n\ttype Context\n} from 'hono';", ['an import from hono']],
			["import 'hono';", ['a bare import of hono']],
			["await import('hono/cookie');", ['a dynamic import of hono']],
			['return new Response(body);', ['`new Response(`']],
			['return Response.json({ ok: true });', ['`Response.json(`']],
			["setCookie(c, 'a', 'b');", ['`setCookie(`']],
			["c.header('Set-Cookie', v);", ['a `Set-Cookie` header write']],
			['c.header("set-cookie", v, { append: true });', ['a `Set-Cookie` header write']],
			["import { route_ok } from '../http/route_result.ts';", []],
			[" * a handler never calls `new Response(` or `c.header('Set-Cookie', v)`", []],
			["// import type { Context } from 'hono';", []]
		];
		for (const [source, expected] of cases) {
			assert.deepStrictEqual(census_route_module(source), expected, source);
		}
		assert.ok(is_route_module('export const x = define_route({});'));
		assert.ok(is_route_module('attach_route_handler(shape, () => route_ok(1));'));
		assert.ok(!is_route_module('// define_route(spec)'));
	});
});
