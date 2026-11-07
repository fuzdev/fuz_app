/**
 * Whether an error response is one its route declares — the one rule the DEV
 * error check (`http/dev_route_error_check.ts`) and the test helpers
 * (`assert_response_matches_spec`) share.
 *
 * A JSON body at an error status (400 and up) is declared when the route's
 * error map (`resolve_route_error_map`) has that status and the body parses
 * against it. Three exemptions: a 500 `internal_error` and a 503
 * `service_unavailable` (`ALWAYS_ACCEPTED_ERRORS`), which the catch layers
 * answer on any route and no route declares, and, on a `jsonrpc` route, a
 * JSON-RPC error envelope, which no REST error definition describes. A
 * non-JSON response, by `is_json_response`, is not checked at all.
 *
 * Also the hono-free route lookup the test helpers run (`find_route_spec`):
 * a route's Hono path template read segment by segment (`split_route_template`,
 * `parse_route_param`) and compiled to a `RegExp` (`compile_route_path`),
 * and the first route in mount order matching a request, `HEAD` read as
 * `GET` (`find_mounted_route`). The DEV check, on the Hono side, looks routes
 * up with Hono's own router (`create_route_lookup`); the two are pinned
 * against Hono and each other by the route-lookup tests.
 *
 * Hono-free and `esm-env`-free.
 *
 * @module
 */

import { is, parse, type SchemaIssue } from '@fuzdev/fuz_schema/schema.ts';

import {
	REST_INTERNAL_ERROR,
	REST_SERVICE_UNAVAILABLE,
	type RestErrorDef
} from './error_schemas.ts';
import { is_jsonrpc_error_response } from './jsonrpc_helpers.ts';
import type { RouteErrorMap } from './route_errors.ts';

/**
 * The errors any route can answer with and none declares: the catch layer's
 * 500 `internal_error` for a generic throw, and a failed pool checkout's 503
 * `service_unavailable`. Always accepted by `check_route_error`.
 */
export const ALWAYS_ACCEPTED_ERRORS: ReadonlyArray<RestErrorDef> = [
	REST_INTERNAL_ERROR,
	REST_SERVICE_UNAVAILABLE
];

/**
 * Whether a status is an error status, the ones `check_route_error` reads:
 * 400 and up.
 *
 * @param status - the HTTP status
 */
export const is_error_status = (status: number): boolean => status >= 400;

/**
 * Whether a response is JSON by its `Content-Type`, the gate before any
 * error check: a non-JSON response (SSE, bytes, Hono's plain-text 404) is no
 * error body to check, whatever its text looks like.
 *
 * @param response - the response
 */
export const is_json_response = (response: Response): boolean =>
	response.headers.get('Content-Type')?.includes('application/json') ?? false;

/** What `check_route_error` found of an error response. */
export type RouteErrorCheck =
	| { ok: true }
	| { ok: false; kind: 'undeclared_status' }
	| { ok: false; kind: 'schema_mismatch'; issues: Array<SchemaIssue> };

/**
 * Check a JSON error body against its route's error map.
 *
 * @param errors - the route's error map
 * @param status - the response status, an error status (`is_error_status`)
 * @param body - the parsed JSON body
 * @param jsonrpc - whether the route answers JSON-RPC envelopes (`RouteSpec.jsonrpc`)
 * @returns `ok`, or why not: no definition at the status, or a body off the status's schema
 */
export const check_route_error = (
	errors: RouteErrorMap,
	status: number,
	body: unknown,
	jsonrpc: boolean
): RouteErrorCheck => {
	// the JSON-RPC endpoint answers its refusals as envelopes, which no REST
	// error definition describes; the dispatch core checks its own outputs
	if (jsonrpc && is_jsonrpc_error_response(body)) return { ok: true };
	if (ALWAYS_ACCEPTED_ERRORS.some((def) => def.status === status && is(def.schema, body))) {
		return { ok: true };
	}
	const schema = errors.schemas[status];
	if (!schema) return { ok: false, kind: 'undeclared_status' };
	const result = parse(schema, body);
	return result.ok ? { ok: true } : { ok: false, kind: 'schema_mismatch', issues: result.issues };
};

/**
 * Format a failed `check_route_error` as one line: `Undeclared error status
 * (S): METHOD path` or `Error schema mismatch (S): METHOD path`. The DEV
 * check logs it, with the issues or the body as a second argument; the test
 * helpers (`assert_response_matches_spec`, `assert_error_response_declared`)
 * throw it with the issues or the body as JSON after a `: `.
 *
 * @param check - the failed check
 * @param status - the response status
 * @param route - what names the request, `METHOD path`
 */
export const format_route_error_check = (
	check: Exclude<RouteErrorCheck, { ok: true }>,
	status: number,
	route: string
): string =>
	check.kind === 'undeclared_status'
		? `Undeclared error status (${status}): ${route}`
		: `Error schema mismatch (${status}): ${route}`;

// --- route lookup ---

const escape_regexp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A param segment as Hono reads one: `:name`, or `:name{re}` (`getPattern`). */
const PARAM_SEGMENT = /^:([^{}]+)(?:\{(.+)\})?$/;

/** A param segment of a route template, as `parse_route_param` reads it. */
export interface RouteParam {
	/** The param's name, the key of its value in the route's `params`. */
	readonly name: string;
	/** The `re` of `:name{re}`, or `null` for a bare `:name`. */
	readonly pattern: string | null;
	/** Whether the segment ends in `?`, an optional param. */
	readonly optional: boolean;
}

/**
 * Read a template segment as Hono reads a param: a whole segment `:name` or
 * `:name{re}`, either with a trailing `?`. A segment that doesn't start with
 * `:` is literal text, a `:` inside it (`files:upload`) included.
 *
 * @param segment - one segment of a template split by `split_route_template`
 * @returns the param, or `null` for a segment that is not one
 */
export const parse_route_param = (segment: string): RouteParam | null => {
	const optional = segment.startsWith(':') && segment.endsWith('?');
	const param = PARAM_SEGMENT.exec(optional ? segment.slice(0, -1) : segment);
	return param ? { name: param[1]!, pattern: param[2] ?? null, optional } : null;
};

/**
 * A template's segments, split on `/` with each `{…}` group kept whole, as
 * Hono's `splitRoutingPath` splits them; a leading `/` gives no empty first
 * segment.
 *
 * @param template - a route's path template
 */
export const split_route_template = (template: string): Array<string> => {
	const groups: Array<[string, string]> = [];
	const marked = template.replace(/\{[^}]+\}/g, (group, index: number) => {
		const mark = `@${index}`;
		groups.push([mark, group]);
		return mark;
	});
	const segments = marked.split('/');
	if (segments[0] === '') segments.shift();
	for (let i = groups.length - 1; i >= 0; i--) {
		const [mark, group] = groups[i]!;
		for (let j = segments.length - 1; j >= 0; j--) {
			if (segments[j]!.includes(mark)) {
				segments[j] = segments[j]!.replace(mark, group);
				break;
			}
		}
	}
	return segments;
};

/**
 * The templates an optional param expands to, as Hono's
 * `checkOptionalParameter` expands them: a template ending in `?` that holds a
 * param is one template without each optional segment and one with it.
 * `null` for a template with none.
 */
const expand_optional_params = (template: string): Array<string> | null => {
	if (!template.endsWith('?') || !template.includes(':')) return null;
	const results: Array<string> = [];
	let base = '';
	for (const segment of template.split('/')) {
		if (segment !== '' && !segment.includes(':')) {
			base += `/${segment}`;
		} else if (segment.includes(':')) {
			if (segment.endsWith('?')) {
				results.push(results.length === 0 && base === '' ? '/' : base);
				base += `/${segment.slice(0, -1)}`;
				results.push(base);
			} else {
				base += `/${segment}`;
			}
		}
	}
	return results.filter((v, i, a) => a.indexOf(v) === i);
};

/**
 * The regexp source of a `{re}` param's pattern, grouped so an alternation
 * stays inside it, as Hono's RegExpRouter reads it.
 */
const to_route_param_source = (pattern: string): string => `(?:${pattern})`;

/**
 * Compile the `re` of a `:name{re}` param to the `RegExp` a value of the param
 * must match, grouped and anchored at both ends, `^(?:re)$`, as
 * `compile_route_path` reads it inside a template. That is Hono's RegExpRouter
 * reading; its TrieRouter, which SmartRouter falls back to for some route
 * sets, anchors `^re$` and leaves a top-level alternation ungrouped, so
 * `^a|b$` takes `ab` where the grouped form refuses it. The grouped form is
 * the stricter of the two: a value it accepts both routers accept. Test it
 * against the value as Hono reads it (`decode_route_path`).
 *
 * @param pattern - the param's `re` (`RouteParam.pattern`)
 */
export const compile_route_param_pattern = (pattern: string): RegExp =>
	new RegExp(`^${to_route_param_source(pattern)}$`);

/**
 * A request path, or a part of one, as Hono's router reads it: percent-decoded
 * by `decodeURI` with `%25` kept, so an encoded `/`, `#`, `?` or `%` stays
 * encoded, or the raw text when decoding fails.
 *
 * @param path - the request pathname, or a percent-encoded segment of one
 */
export const decode_route_path = (path: string): string => {
	if (!path.includes('%')) return path;
	try {
		return decodeURI(path.replaceAll('%25', '%2525'));
	} catch {
		// a malformed escape: Hono matches the raw path
		return path;
	}
};

/** The regexp source of a template with no optional param. */
const to_route_path_source = (template: string): string => {
	const segments = split_route_template(template);
	let source = '';
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i]!;
		if (segment === '*') {
			// a trailing `/*` is the prefix with anything after it, or nothing
			source += i === segments.length - 1 ? '(?:/.*)?' : '/[^/]+';
			continue;
		}
		const param = PARAM_SEGMENT.exec(segment);
		if (param) {
			source += param[2] ? `/${to_route_param_source(param[2])}` : '/[^/]+';
			continue;
		}
		if (segment.includes('*')) {
			// Hono reads a `*` inside a segment as a wildcard (`/a*` matches `/abc`);
			// refuse it rather than guess its reach
			throw new Error(
				`compile_route_path: ${JSON.stringify(template)} has a \`*\` inside a segment (${JSON.stringify(segment)}), which this lookup does not read`
			);
		}
		source += `/${escape_regexp(segment)}`;
	}
	return source;
};

/**
 * Compile a Hono path template to a `RegExp` over request paths, reading it
 * as Hono 4's routers do: the template is split on `/` with each `{…}` group
 * kept whole, and each segment is a `*`, a param — a whole segment
 * `:name` (one non-empty segment) or `:name{re}` (the pattern `re`, which may
 * span segments) — or literal text, so a `:` inside a segment (`files:upload`,
 * `:x-:y`'s second) is no param of its own; a literal segment holding a `*`
 * (`/a*`), a wildcard in Hono, throws rather than be guessed at. A template
 * ending in `?` expands
 * its optional params as Hono's `checkOptionalParameter` does. A trailing
 * `/*` matches the prefix with anything after it or nothing (so `/api/*`
 * matches `/api`), a `*` elsewhere one non-empty segment, and `*` alone every
 * path. Trailing slashes are strict, as Hono's are by default. Pinned against
 * Hono itself by the route-lookup tests.
 *
 * @param template - the route's path template (`RouteSpec.path`)
 * @returns an anchored `RegExp` over a request path
 * @throws Error on a segment holding a `*` that is not the whole segment
 *   (`/a*`), a wildcard in Hono this lookup refuses to guess at
 */
export const compile_route_path = (template: string): RegExp => {
	if (template === '*') return /^.*$/;
	const expanded = expand_optional_params(template);
	const source = expanded
		? `(?:${expanded.map((t) => (t === '/' ? '/' : to_route_path_source(t))).join('|')})`
		: template === '/'
			? '/'
			: to_route_path_source(template);
	return new RegExp(`^${source}$`);
};

/** A route a request can be matched to: its method, its compiled path, and what the caller keeps beside it. */
export interface MountedRoute<T> {
	readonly method: string;
	readonly pattern: RegExp;
	readonly value: T;
}

/**
 * Compile routes for `find_mounted_route`, in mount order.
 *
 * @param routes - the routes, in the order they were mounted
 * @param to_value - what to keep beside each route
 */
export const to_mounted_routes = <
	TRoute extends { readonly method: string; readonly path: string },
	T
>(
	routes: ReadonlyArray<TRoute>,
	to_value: (route: TRoute) => T
): Array<MountedRoute<T>> =>
	routes.map((route) => ({
		method: route.method,
		pattern: compile_route_path(route.path),
		value: to_value(route)
	}));

/**
 * The first route in mount order that a request matches, as Hono picks the
 * handler — a `HEAD` read as a `GET`, which Hono answers it with.
 *
 * @param routes - the routes, compiled by `to_mounted_routes`
 * @param method - the request method
 * @param path - the request path
 * @returns the matched route's value, or `undefined` when no route matches
 */
export const find_mounted_route = <T>(
	routes: ReadonlyArray<MountedRoute<T>>,
	method: string,
	path: string
): T | undefined => {
	const read_method = method === 'HEAD' ? 'GET' : method;
	for (const route of routes) {
		if (route.method === read_method && route.pattern.test(path)) return route.value;
	}
	return undefined;
};
