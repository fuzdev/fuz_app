/**
 * Static file serving middleware for SvelteKit static builds.
 *
 * Multi-step static serving:
 * - Step 1: Exact path match (handles /, assets, images)
 * - Step 2: `.html` fallback for clean URLs (`/about` → `/about.html`)
 * - Step 3 (optional): SPA fallback for client-side routes
 *
 * The server routes on the raw request path (`get_request_path`), and a
 * runtime's `serveStatic` refuses a path holding a `%` — it expects one the
 * router already decoded. So a path with an escape is decoded here first
 * (`to_static_file_path`) and handed to `serveStatic` as the file to serve;
 * one with no escape goes to it as is. The SPA fallback names its file
 * outright, so no step but the exact match hands `serveStatic` the request
 * path.
 *
 * @module
 */

import type { MiddlewareHandler } from 'hono';

/**
 * Options for `serve_static` factory functions (matches Hono's `serveStatic` signature).
 */
export interface ServeStaticOptions {
	root: string;
	rewriteRequestPath?: (path: string) => string;
	mimes?: Record<string, string>;
	/** The file to serve, relative to `root`, in place of the request's path. */
	path?: string;
}

/**
 * Factory function that creates a static file serving middleware.
 *
 * Matches the signature of `serveStatic` from `@hono/node-server/serve-static` and `@hono/bun`.
 */
export type ServeStaticFactory = (options: ServeStaticOptions) => MiddlewareHandler;

/** A dot segment, an empty segment, a backslash or a NUL — what `serveStatic` refuses too, the NUL aside. */
const UNSAFE_STATIC_PATH = /(?:^|[/\\])\.{1,2}(?:$|[/\\])|[/\\]{2,}|\\|\0/;

/**
 * The file a raw request path names, each segment percent-decoded by
 * `decodeURIComponent` — or `null`, no file, for an escape that doesn't
 * decode, a segment that decodes to a `/` or a `%` (which `serveStatic`
 * never served: it refused the router's decoded path holding either), and a
 * decoded path holding a dot segment, an empty segment, a backslash or a NUL.
 *
 * @param path - the raw request path
 */
export const to_static_file_path = (path: string): string | null => {
	const segments: Array<string> = [];
	for (const segment of path.split('/')) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(segment);
		} catch {
			return null;
		}
		if (decoded.includes('/') || decoded.includes('%')) return null;
		segments.push(decoded);
	}
	const file = segments.join('/');
	return UNSAFE_STATIC_PATH.test(file) ? null : file;
};

/** Default SPA route filter — serves the SPA fallback for all paths except `/api` and `/api/…`. */
const is_spa_route_default = (path: string): boolean =>
	path !== '/api' && !path.startsWith('/api/');

/**
 * Create static file serving middleware for SvelteKit static builds.
 *
 * Returns an array of middleware handlers to register on `'/*'`.
 *
 * @param serve_static - runtime-specific `serveStatic` factory
 * @param options - optional root directory and SPA fallback path
 */
export const create_static_middleware = (
	serve_static: ServeStaticFactory,
	options?: { root?: string; spa_fallback?: string; is_spa_route?: (path: string) => boolean }
): Array<MiddlewareHandler> => {
	const root = options?.root ?? './build';
	const handlers: Array<MiddlewareHandler> = [];

	// Step 1: exact path match — a path with an escape decoded here, since
	// `serve_static` refuses a `%`
	const serve_exact = serve_static({ root });
	handlers.push(async (c, next) => {
		const path = c.req.path;
		if (!path.includes('%')) return serve_exact(c, next);
		const file = to_static_file_path(path);
		if (file === null) return next();
		return serve_static({ root, path: file })(c, next);
	});

	// Step 2: .html fallback for clean URLs (/about → /about.html)
	handlers.push(async (c, next) => {
		const file = to_static_file_path(c.req.path);
		if (file === null || file === '/' || file.includes('.')) return next();
		return serve_static({ root, path: `${file}.html` })(c, next);
	});

	// Step 3: optional SPA fallback for client-side routes — the fallback named
	// as the file, since `serve_static` refuses a request path holding a `%`
	// (a client route's encoded param) before it reads a rewrite
	if (options?.spa_fallback) {
		const serve_fallback = serve_static({ root, path: options.spa_fallback });
		const is_spa_route = options.is_spa_route ?? is_spa_route_default;
		handlers.push(async (c, next) => {
			if (!is_spa_route(c.req.path)) return next();
			return serve_fallback(c, next);
		});
	}

	return handlers;
};
