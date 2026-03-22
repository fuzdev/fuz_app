/**
 * Tests for server/static - static file serving middleware.
 *
 * @module
 */

import {describe, assert, test, vi} from 'vitest';
import type {MiddlewareHandler} from 'hono';

import {create_static_middleware, type ServeStaticFactory} from '$lib/server/static.js';

/** Create a mock serve_static factory that records calls. */
const create_mock_serve_static = (): {
	factory: ServeStaticFactory;
	calls: Array<{root: string; rewriteRequestPath?: (path: string) => string}>;
} => {
	const calls: Array<{root: string; rewriteRequestPath?: (path: string) => string}> = [];
	const noop_handler: MiddlewareHandler = async (_c, next) => next();
	const factory: ServeStaticFactory = (options) => {
		calls.push(options);
		return noop_handler;
	};
	return {factory, calls};
};

describe('create_static_middleware', () => {
	test('returns at least 2 handlers by default (exact + html fallback)', () => {
		const {factory} = create_mock_serve_static();
		const handlers = create_static_middleware(factory);
		assert.strictEqual(handlers.length, 2);
	});

	test('returns 3 handlers when spa_fallback is provided', () => {
		const {factory} = create_mock_serve_static();
		const handlers = create_static_middleware(factory, {spa_fallback: '/200.html'});
		assert.strictEqual(handlers.length, 3);
	});

	test('uses default root ./build', () => {
		const {factory, calls} = create_mock_serve_static();
		create_static_middleware(factory);
		assert.strictEqual(calls[0]!.root, './build');
	});

	test('uses custom root', () => {
		const {factory, calls} = create_mock_serve_static();
		create_static_middleware(factory, {root: './dist'});
		assert.strictEqual(calls[0]!.root, './dist');
	});

	test('phase 1 serve_static is called with root only (no rewrite)', () => {
		const {factory, calls} = create_mock_serve_static();
		create_static_middleware(factory);

		// Phase 1 is a direct serve_static call
		assert.strictEqual(calls.length, 1); // only phase 1 calls factory eagerly
		assert.strictEqual(calls[0]!.rewriteRequestPath, undefined);
	});

	test('phase 3 spa_fallback uses the provided path', () => {
		const serve_static_calls: Array<{
			root: string;
			rewriteRequestPath?: (path: string) => string;
		}> = [];
		const noop_handler: MiddlewareHandler = async (_c, next) => next();
		const factory: ServeStaticFactory = (options) => {
			serve_static_calls.push(options);
			return noop_handler;
		};

		create_static_middleware(factory, {spa_fallback: '/200.html'});

		// Phase 3 is the last serve_static call
		const phase3 = serve_static_calls[serve_static_calls.length - 1]!;
		assert.ok(phase3.rewriteRequestPath);
		assert.strictEqual(phase3.rewriteRequestPath('/anything'), '/200.html');
		assert.strictEqual(phase3.rewriteRequestPath('/deep/nested/path'), '/200.html');
	});

	test('no spa_fallback produces only 2 handlers', () => {
		const {factory} = create_mock_serve_static();
		const handlers = create_static_middleware(factory, {root: './build'});
		assert.strictEqual(handlers.length, 2);
	});

	test('phase 2 html fallback handler calls next for root path', async () => {
		let next_called = false;
		const noop_handler: MiddlewareHandler = async (_c, next) => next();
		const factory: ServeStaticFactory = () => noop_handler;

		const handlers = create_static_middleware(factory);
		const phase2 = handlers[1]!;

		// Mock context with root path
		const c = {req: {path: '/'}} as any;
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

		const c = {req: {path: '/assets/style.css'}} as any;
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

		const c = {req: {path: '/about'}} as any;
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

		const c = {req: {path: '/docs/getting-started'}} as any;
		await phase2(c, vi.fn());

		assert.strictEqual(rewrite_path, '/docs/getting-started.html');
	});
});
