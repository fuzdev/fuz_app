/**
 * The DEV-only error check: an outer middleware that logs every JSON error
 * response its route doesn't declare.
 *
 * Mounted outermost by `create_app_server`, so it sees what every layer
 * answers — a middleware's refusal (the body limit, the origin check, the
 * auth guards) as much as a handler's or the error catch's. After the request
 * it finds the route the request reached (`create_route_lookup`: Hono's own
 * router over the route specs in mount order, `HEAD` read as `GET`) and checks the
 * response against that route's error map (`check_route_error`): an error
 * status the map lacks, or a body off the status's schema, is logged. A 500
 * `internal_error` and a 503 `service_unavailable` are always accepted, a
 * JSON-RPC error envelope on a `jsonrpc` route is not a REST error body, a
 * non-JSON response is skipped, and so is a request no route spec matches
 * (an unmatched path's 404 is Hono's plain text, no JSON convention to hold
 * it to).
 *
 * Logs, never throws — a throw inside it, its logger's included, is swallowed
 * — and leaves the response unchanged. Outside DEV
 * `create_dev_route_error_check` returns `null` and nothing is mounted.
 *
 * @module
 */

import type { MiddlewareHandler } from 'hono';
import { RegExpRouter } from 'hono/router/reg-exp-router';
import { SmartRouter } from 'hono/router/smart-router';
import { TrieRouter } from 'hono/router/trie-router';
import { DEV } from 'esm-env';
import type { Logger } from '@fuzdev/fuz_util/log.ts';

import {
	check_route_error,
	format_route_error_check,
	is_error_status,
	is_json_response
} from './route_error_check.ts';
import { get_route_error_map, type RouteErrorMap, type RouteErrorMapSpec } from './route_errors.ts';

/**
 * A lookup of the route a request reaches, by Hono's own router — the
 * `SmartRouter` over a `RegExpRouter` and a `TrieRouter` that `new Hono()`
 * builds: the routes are added in mount order, and a request's first match is
 * the route Hono dispatches it to — `HEAD` read as `GET`, which Hono answers
 * it with.
 *
 * Its router holds only the route specs, while the app's also holds every
 * middleware and non-spec route (WS upgrades, static serving), which can put
 * the app on a different router than the lookup's — a `TrieRouter` where the
 * lookup has a `RegExpRouter`. Where the two differ the cost is a missed DEV
 * log, and rarely a wrong route.
 *
 * @param routes - the routes, in the order they were mounted
 * @param to_value - what to keep beside each route
 * @returns a function from a request's method and path to the matched route's
 *   value, or `undefined` when none matches
 */
export const create_route_lookup = <
	TRoute extends { readonly method: string; readonly path: string },
	T
>(
	routes: ReadonlyArray<TRoute>,
	to_value: (route: TRoute) => T
): ((method: string, path: string) => T | undefined) => {
	const values = routes.map(to_value);
	// `new Hono()`'s own router: a `RegExpRouter`, or a `TrieRouter` where the
	// route set has a template the first can't compile — the two differ on an
	// edge or two (`/w/*/c` on `/w//c`), so the lookup takes the one Hono would
	const router = new SmartRouter<number>({
		routers: [new RegExpRouter(), new TrieRouter()]
	});
	routes.forEach((route, i) => router.add(route.method, route.path, i));
	return (method, path) => {
		const [matches] = router.match(method === 'HEAD' ? 'GET' : method, path);
		const first = matches[0];
		return first === undefined ? undefined : values[first[0]];
	};
};

/** What `create_dev_route_error_check` reads of a route spec. */
export interface DevRouteErrorCheckSpec extends RouteErrorMapSpec {
	readonly jsonrpc?: boolean;
}

/** Options for `create_dev_route_error_check`. */
export interface DevRouteErrorCheckOptions {
	/** The app's route specs, in mount order. */
	route_specs: ReadonlyArray<DevRouteErrorCheckSpec>;
	/** Each route's error map, keyed `METHOD path` (`resolve_app_route_error_maps`). */
	route_error_maps: ReadonlyMap<string, RouteErrorMap>;
	/** Receives each response its route doesn't declare. */
	log: Logger;
}

/**
 * Build the DEV error check (module doc), or `null` outside DEV.
 *
 * @param options - the routes, their error maps, and the logger
 * @returns the middleware to mount outermost, or `null` in production
 * @throws Error when `route_error_maps` lacks a route of `route_specs` (`get_route_error_map`)
 */
export const create_dev_route_error_check = (
	options: DevRouteErrorCheckOptions
): MiddlewareHandler | null => {
	if (!DEV) return null;
	const { route_error_maps, log } = options;
	const find_route = create_route_lookup(options.route_specs, (spec) => ({
		errors: get_route_error_map(route_error_maps, spec),
		jsonrpc: spec.jsonrpc ?? false
	}));
	// named, so an assembled app's route table shows it
	const dev_route_error_check: MiddlewareHandler = async (c, next) => {
		await next();
		// the check never changes the response: a throw in it, a logger's
		// included, is logged if it can be and swallowed, so it never reaches `onError`
		try {
			const response = c.res;
			if (!is_error_status(response.status)) return;
			if (!is_json_response(response)) return;
			const route = find_route(c.req.method, c.req.path);
			if (!route) return;
			let body: unknown;
			try {
				body = await response.clone().json();
			} catch {
				// a body claiming JSON that isn't
				return;
			}
			const check = check_route_error(route.errors, response.status, body, route.jsonrpc);
			if (check.ok) return;
			const message = format_route_error_check(
				check,
				response.status,
				`${c.req.method} ${c.req.path}`
			);
			if (check.kind === 'schema_mismatch') log.error(message, check.issues);
			else log.error(message, body);
		} catch (err) {
			try {
				log.error('dev_route_error_check failed:', err);
			} catch {
				// the logger itself threw; nothing left to tell
			}
		}
	};
	return dev_route_error_check;
};
