/**
 * What a request no route answers gets: the assembled server's not-found
 * handler, twin of the Rust spine's method fallback (`fuz_http::compose_stack`)
 * and fallback group (`fuz_actions::server::unmatched_route_response`).
 *
 * - **A method its path doesn't serve** — the path matches a route under
 *   another method — is `405 {"error":"method_not_allowed"}` with `Allow`
 *   naming the methods the path serves, `HEAD` wherever `GET` is.
 * - **A path no route serves** is `404`: under the auth scope
 *   (`AUTH_MIDDLEWARE_PATH`) the JSON `{"error":"route_not_found"}`, like
 *   every other refusal there; elsewhere the one plain-text `NOT_FOUND_TEXT`.
 *   A route that passed the request on (the WebSocket path's `GET` asking for
 *   no upgrade) answers the same.
 *
 * The methods a path serves are read from the app's own router — every route
 * registered on it, a spec's, a WebSocket upgrade's or one a consumer adds to
 * the assembled app, and never a middleware (`ALL`).
 *
 * Both decide on the raw path the router matched (`get_request_path`), so
 * `/%61pi/x` is outside the auth scope, as on the Rust spine. Hono runs this
 * after every middleware, so the host gate and the origin check answer
 * first, and ahead of authentication, which only the routes enforce: an
 * anonymous `PUT` on the RPC path is the 405, not a 401. The answer is built
 * through the context, so the session middleware's clear of a cookie that
 * doesn't verify rides it like any other.
 *
 * @module
 */

import type { NotFoundHandler } from 'hono';
import type { Router } from 'hono/router';
import type { RouterRoute } from 'hono/types';

import { AUTH_MIDDLEWARE_PATH } from '../auth/middleware.ts';
import {
	ERROR_METHOD_NOT_ALLOWED,
	ERROR_ROUTE_NOT_FOUND,
	NOT_FOUND_TEXT
} from '../http/error_schemas.ts';
import { middleware_applies } from '../http/schema_helpers.ts';

/** The `Content-Type` of `NOT_FOUND_TEXT`, as the Rust spine writes it. */
const NOT_FOUND_CONTENT_TYPE = 'text/plain; charset=utf-8';

/** The methods a route may serve, in the order `Allow` lists them. */
const ROUTE_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** What `create_unmatched_route_handler` reads: the app's router (`app.router`). */
export type UnmatchedRouteRouter = Pick<Router<[unknown, RouterRoute]>, 'match'>;

/**
 * Whether `router` holds a route — not a middleware — for `method` at `path`.
 * A match carries each handler's registration, whose `method` is the one it
 * was added under: a route's own, or `ALL` for a middleware.
 */
const serves = (router: UnmatchedRouteRouter, method: string, path: string): boolean =>
	router.match(method, path)[0].some(([[, route]]) => route.method === method);

/**
 * Build the not-found handler (module doc) over the app's router.
 *
 * @param router - the assembled app's router, `app.router`, read at request
 *   time, so a route added after assembly is seen too
 * @returns the handler for `app.notFound`
 */
export const create_unmatched_route_handler = (router: UnmatchedRouteRouter): NotFoundHandler => {
	return (c) => {
		const path = c.req.path;
		// `HEAD` is served wherever `GET` is, which Hono answers it with
		const allow = ROUTE_METHODS.filter((method) =>
			serves(router, method === 'HEAD' ? 'GET' : method, path)
		);
		const method = c.req.method === 'HEAD' ? 'GET' : c.req.method;
		if (allow.length > 0 && !allow.includes(method as (typeof ROUTE_METHODS)[number])) {
			c.header('Allow', allow.join(', '));
			return c.json({ error: ERROR_METHOD_NOT_ALLOWED }, 405);
		}
		if (middleware_applies(AUTH_MIDDLEWARE_PATH, path)) {
			return c.json({ error: ERROR_ROUTE_NOT_FOUND }, 404);
		}
		return c.body(NOT_FOUND_TEXT, 404, { 'Content-Type': NOT_FOUND_CONTENT_TYPE });
	};
};
