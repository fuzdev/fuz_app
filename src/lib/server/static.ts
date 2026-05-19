/**
 * Static file serving middleware for SvelteKit static builds.
 *
 * Multi-step static serving:
 * - Step 1: Exact path match (handles /, assets, images)
 * - Step 2: `.html` fallback for clean URLs (`/about` → `/about.html`)
 * - Step 3 (optional): SPA fallback for client-side routes
 *
 * @module
 */

import type {MiddlewareHandler} from 'hono';

/**
 * Options for `serve_static` factory functions (matches Hono's `serveStatic` signature).
 */
export interface ServeStaticOptions {
	root: string;
	rewriteRequestPath?: (path: string) => string;
	mimes?: Record<string, string>;
}

/**
 * Factory function that creates a static file serving middleware.
 *
 * Matches the signature of `serveStatic` from `hono/deno` and `@hono/node-server/serve-static`.
 */
export type ServeStaticFactory = (options: ServeStaticOptions) => MiddlewareHandler;

/** Default SPA route filter — serves the SPA fallback for all paths except `/api/`. */
const is_spa_route_default = (path: string): boolean => !path.startsWith('/api/');

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
	options?: {root?: string; spa_fallback?: string; is_spa_route?: (path: string) => boolean},
): Array<MiddlewareHandler> => {
	const root = options?.root ?? './build';
	const handlers: Array<MiddlewareHandler> = [];

	// Step 1: exact path match
	handlers.push(serve_static({root}));

	// Step 2: .html fallback for clean URLs (/about → /about.html)
	handlers.push(async (c, next) => {
		const path = c.req.path;
		if (path === '/' || path.includes('.')) return next();
		return serve_static({root, rewriteRequestPath: () => `${path}.html`})(c, next);
	});

	// Step 3: optional SPA fallback for client-side routes
	if (options?.spa_fallback) {
		const fallback = options.spa_fallback;
		const is_spa_route = options.is_spa_route ?? is_spa_route_default;
		handlers.push(async (c, next) => {
			if (!is_spa_route(c.req.path)) return next();
			return serve_static({root, rewriteRequestPath: () => fallback})(c, next);
		});
	}

	return handlers;
};
