/**
 * Static file serving middleware for SvelteKit static builds.
 *
 * Provides multi-phase static serving:
 * - Phase 1: Exact path match (handles /, assets, images)
 * - Phase 2: `.html` fallback for clean URLs (`/about` → `/about.html`)
 * - Phase 3 (optional): SPA fallback for client-side routes
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

/**
 * Create static file serving middleware for SvelteKit static builds.
 *
 * Returns an array of middleware handlers to register on `'/*'`.
 *
 * @param serve_static - runtime-specific `serveStatic` factory
 * @param options - optional root directory and SPA fallback path
 * @returns array of middleware handlers to apply in order
 */
export const create_static_middleware = (
	serve_static: ServeStaticFactory,
	options?: {root?: string; spa_fallback?: string},
): Array<MiddlewareHandler> => {
	const root = options?.root ?? './build';
	const handlers: Array<MiddlewareHandler> = [];

	// Phase 1: exact path match
	handlers.push(serve_static({root}));

	// Phase 2: .html fallback for clean URLs (/about → /about.html)
	handlers.push(async (c, next) => {
		const path = c.req.path;
		if (path === '/' || path.includes('.')) return next();
		return serve_static({root, rewriteRequestPath: () => `${path}.html`})(c, next);
	});

	// Phase 3: optional SPA fallback for client-side routes
	if (options?.spa_fallback) {
		const fallback = options.spa_fallback;
		handlers.push(serve_static({root, rewriteRequestPath: () => fallback}));
	}

	return handlers;
};
