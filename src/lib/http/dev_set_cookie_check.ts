/**
 * The DEV-only `Set-Cookie` check: an outer middleware that logs a response
 * which does not lead with the `Set-Cookie` line a middleware put on the
 * context for every response.
 *
 * A middleware that writes a line on the context's prepared headers — the
 * session middleware's clear of a stale cookie — records it under
 * `EXPECTED_FIRST_SET_COOKIE_KEY`. Every response built through the context
 * then carries it first: every route result, which the spine emits there,
 * and every middleware and catch layer answering with `c.json` or `c.text`.
 * A response built past the context does not — a consumer's
 * `post_route_middleware`, a `transform_middleware` layer, or a raw Hono route
 * answering with a `Response` it made — and only a check of the finished
 * response can see that, so this one runs after the request: when a line was
 * recorded, the response's first `Set-Cookie` must be that line, else it logs
 * an error naming the method and path, and whether the response carries no
 * `Set-Cookie` or another one first.
 *
 * One response is skipped: an accepted WebSocket upgrade's placeholder. No
 * runtime adapter hands Hono a `101` — `@hono/node-server`'s and `@hono/bun`'s
 * `upgradeWebSocket` return a bodiless `200` and the runtime writes the real
 * `101` itself — so the check recognizes the placeholder by its shape: a
 * request with `Upgrade: websocket` answered `200` with no body. That
 * placeholder is no response a client reads, and no layer builds it through
 * the context. The cost: a raw route answering a bodiless `200` to an upgrade
 * request it did not accept goes unchecked too.
 *
 * Generic: it knows a line and an order, nothing of sessions. A sibling of
 * the DEV error check (`http/dev_route_error_check.ts`) rather than part of
 * it, as that one reads the route a request reached and only its error
 * answers, where this one holds every answer of every path, routed or not.
 * Mounted outermost beside it by `create_app_server`. Logs, never throws — a
 * throw inside it, its logger's included, is swallowed — and leaves the
 * response unchanged. Outside DEV `create_dev_set_cookie_check` returns `null`
 * and nothing is mounted.
 *
 * @module
 */

import type { MiddlewareHandler } from 'hono';
import { DEV } from 'esm-env';
import type { Logger } from '@fuzdev/fuz_util/log.ts';

import { EXPECTED_FIRST_SET_COOKIE_KEY } from '../hono_context.ts';

/** Options for `create_dev_set_cookie_check`. */
export interface DevSetCookieCheckOptions {
	/** Receives each response that does not lead with the recorded line. */
	log: Logger;
}

/**
 * Build the DEV `Set-Cookie` check (module doc), or `null` outside DEV.
 *
 * @param options - the logger
 * @returns the middleware to mount outermost, or `null` in production
 */
export const create_dev_set_cookie_check = (
	options: DevSetCookieCheckOptions
): MiddlewareHandler | null => {
	if (!DEV) return null;
	const { log } = options;
	// named, so an assembled app's route table shows it
	const dev_set_cookie_check: MiddlewareHandler = async (c, next) => {
		await next();
		try {
			const expected = c.get(EXPECTED_FIRST_SET_COOKIE_KEY);
			if (expected === undefined) return;
			const response = c.res;
			// an accepted upgrade's placeholder (module doc)
			if (
				c.req.header('upgrade')?.toLowerCase() === 'websocket' &&
				response.status === 200 &&
				response.body === null
			) {
				return;
			}
			const first = response.headers.getSetCookie()[0];
			if (first === expected) return;
			log.error(
				`Response without the expected first Set-Cookie: ${c.req.method} ${c.req.path} — ${
					first === undefined ? 'it carries no Set-Cookie' : 'another Set-Cookie comes first'
				}`
			);
		} catch (err) {
			try {
				log.error('dev_set_cookie_check failed:', err);
			} catch {
				// the logger itself threw; nothing left to tell
			}
		}
	};
	return dev_set_cookie_check;
};
