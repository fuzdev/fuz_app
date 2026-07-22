/**
 * Tests for server/static - static file serving middleware.
 *
 * @module
 */

import { describe, assert, test, vi } from 'vitest';
import type { MiddlewareHandler } from 'hono';

import { create_static_middleware, type ServeStaticFactory } from '$lib/server/static.ts';

/** Create a mock serve_static factory that records calls. */
const create_mock_serve_static = (): {
	factory: ServeStaticFactory;
	calls: Array<{ root: string; rewriteRequestPath?: (path: string) => string }>;
} => {
	const calls: Array<{ root: string; rewriteRequestPath?: (path: string) => string }> = [];
	const noop_handler: MiddlewareHandler = async (_c, next) => next();
	const factory: ServeStaticFactory = (options) => {
		calls.push(options);
		return noop_handler;
	};
	return { factory, calls };
};

describe('create_static_middleware', () => {
	test('returns at least 2 handlers by default (exact + html fallback)', () => {
		const { factory } = create_mock_serve_static();
		const handlers = create_static_middleware(factory);
		assert.strictEqual(handlers.length, 2);
	});

	test('returns 3 handlers when spa_fallback is provided', () => {
		const { factory } = create_mock_serve_static();
		const handlers = create_static_middleware(factory, { spa_fallback: '/200.html' });
		assert.strictEqual(handlers.length, 3);
	});

	test('uses default root ./build', () => {
		const { factory, calls } = create_mock_serve_static();
		create_static_middleware(factory);
		assert.strictEqual(calls[0]!.root, './build');
	});

	test('uses custom root', () => {
		const { factory, calls } = create_mock_serve_static();
		create_static_middleware(factory, { root: './dist' });
		assert.strictEqual(calls[0]!.root, './dist');
	});

	test('step 1 serve_static is called with root only (no rewrite)', () => {
		const { factory, calls } = create_mock_serve_static();
		create_static_middleware(factory);

		// Step 1 is a direct serve_static call
		assert.strictEqual(calls.length, 1); // only step 1 calls factory eagerly
		assert.strictEqual(calls[0]!.rewriteRequestPath, undefined);
	});

	test('step 3 spa_fallback uses the provided path', async () => {
		let rewrite_path: string | undefined;
		const factory: ServeStaticFactory = (options) => {
			const handler: MiddlewareHandler = async (_c, next) => {
				if (options.rewriteRequestPath) {
					rewrite_path = options.rewriteRequestPath('/anything');
				}
				await next();
			};
			return handler;
		};

		const handlers = create_static_middleware(factory, { spa_fallback: '/200.html' });
		const phase3 = handlers[2]!;

		const c = { req: { path: '/anything' } } as any;
		await phase3(c, vi.fn());

		assert.strictEqual(rewrite_path, '/200.html');
	});

	test('phase 3 skips /api/ paths by default', async () => {
		let serve_static_called = false;
		let next_called = false;
		const factory: ServeStaticFactory = () => {
			const handler: MiddlewareHandler = async () => {
				serve_static_called = true;
			};
			return handler;
		};

		const handlers = create_static_middleware(factory, { spa_fallback: '/200.html' });
		const phase3 = handlers[2]!;

		const c = { req: { path: '/api/zap/files' } } as any;
		await phase3(c, async () => {
			next_called = true;
		});

		assert.strictEqual(serve_static_called, false);
		assert.strictEqual(next_called, true);
	});

	test('phase 3 respects custom is_spa_route', async () => {
		let serve_static_called = false;
		let next_called = false;
		const factory: ServeStaticFactory = () => {
			const handler: MiddlewareHandler = async () => {
				serve_static_called = true;
			};
			return handler;
		};

		const handlers = create_static_middleware(factory, {
			spa_fallback: '/200.html',
			is_spa_route: (path) => !path.startsWith('/internal/')
		});
		const phase3 = handlers[2]!;

		// /internal/ path should be skipped
		const c1 = { req: { path: '/internal/status' } } as any;
		await phase3(c1, async () => {
			next_called = true;
		});
		assert.strictEqual(serve_static_called, false);
		assert.strictEqual(next_called, true);

		// /admin path should get SPA fallback (custom filter allows it)
		serve_static_called = false;
		const c2 = { req: { path: '/admin' } } as any;
		await phase3(c2, vi.fn());
		assert.strictEqual(serve_static_called, true);
	});

	test('no spa_fallback produces only 2 handlers', () => {
		const { factory } = create_mock_serve_static();
		const handlers = create_static_middleware(factory, { root: './build' });
		assert.strictEqual(handlers.length, 2);
	});

	test('phase 2 html fallback handler calls next for root path', async () => {
		let next_called = false;
		const noop_handler: MiddlewareHandler = async (_c, next) => next();
		const factory: ServeStaticFactory = () => noop_handler;

		const handlers = create_static_middleware(factory);
		const phase2 = handlers[1]!;

		// Mock context with root path
		const c = { req: { path: '/' } } as any;
		await phase2(c, async () => {
			next_called = true;
		});
		assert.strictEqual(next_called, true);
	});

	test('phase 2 html fallback handler calls next for paths with dots', async () => {
		let next_called = false;
		const noop_handler: MiddlewareHandler = async (_c, next) => next();
		const factory: ServeStaticFactory = () => noop_handler;

		const handlers = create_static_middleware(factory);
		const phase2 = handlers[1]!;

		const c = { req: { path: '/assets/style.css' } } as any;
		await phase2(c, async () => {
			next_called = true;
		});
		assert.strictEqual(next_called, true);
	});

	test('phase 2 html fallback handler invokes serve_static for clean URLs', async () => {
		let rewrite_path: string | undefined;
		const factory: ServeStaticFactory = (options) => {
			const handler: MiddlewareHandler = async (_c, next) => {
				if (options.rewriteRequestPath) {
					rewrite_path = options.rewriteRequestPath('/about');
				}
				await next();
			};
			return handler;
		};

		const handlers = create_static_middleware(factory);
		const phase2 = handlers[1]!;

		const c = { req: { path: '/about' } } as any;
		await phase2(c, vi.fn());

		assert.strictEqual(rewrite_path, '/about.html');
	});

	test('phase 2 html fallback rewrites nested paths', async () => {
		let rewrite_path: string | undefined;
		const factory: ServeStaticFactory = (options) => {
			const handler: MiddlewareHandler = async (_c, next) => {
				if (options.rewriteRequestPath) {
					rewrite_path = options.rewriteRequestPath('/docs/getting-started');
				}
				await next();
			};
			return handler;
		};

		const handlers = create_static_middleware(factory);
		const phase2 = handlers[1]!;

		const c = { req: { path: '/docs/getting-started' } } as any;
		await phase2(c, vi.fn());

		assert.strictEqual(rewrite_path, '/docs/getting-started.html');
	});
});
