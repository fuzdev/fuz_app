/**
 * Tests for `assert_middleware_stack_mounted` — a `transform_middleware`
 * result must keep each spec of the stack it was handed (the trusted proxy,
 * then the auth middleware), matched by handler, mounted once at its original
 * path in its original order — and for the two assemblies that run it:
 * `create_test_app_surface_spec` and `create_app_server`, which hand the
 * transform copies so mutating them in place can't slip past the check.
 *
 * That `create_app_server` releases what it acquired when the check throws is
 * `create_app_server.release.test.ts`.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';

import {
	AUTH_MIDDLEWARE_PATH,
	assert_middleware_stack_mounted,
	create_auth_middleware_specs
} from '$lib/auth/middleware.ts';
import type { DaemonTokenState } from '$lib/auth/daemon_token.ts';
import { create_session_config } from '$lib/auth/session_cookie.ts';
import { create_health_route_spec } from '$lib/http/common_routes.ts';
import type { MiddlewareSpec } from '$lib/http/middleware_spec.ts';
import { create_proxy_middleware_spec } from '$lib/http/proxy.ts';
import { create_app_server, type AppServerOptions } from '$lib/server/app_server.ts';
import {
	create_stub_api_middleware,
	create_stub_app_backend,
	create_stub_app_deps,
	create_test_app_surface_spec,
	stub_mw
} from '$lib/testing/stubs.ts';
import { create_loopback_app_server_options } from '$lib/testing/app_server.ts';

type TransformMiddleware = (specs: Array<MiddlewareSpec>) => Array<MiddlewareSpec>;

const session_options = create_session_config('test_session');

const proxy_options = {
	trusted_proxies: ['127.0.0.1'],
	get_connection_ip: () => '127.0.0.1'
};

const create_daemon_token_state = (): DaemonTokenState => ({
	current_token: 'tok',
	previous_token: null,
	rotated_at: new Date(),
	keeper_account_id: null
});

/** The stack `create_app_server` hands a transform: the proxy spec, then the auth specs. */
const create_stack = async (include_daemon_token = false): Promise<Array<MiddlewareSpec>> => [
	create_proxy_middleware_spec(proxy_options),
	...(await create_auth_middleware_specs(create_stub_app_deps(), {
		allowed_origins: [],
		session_options,
		daemon_token_state: include_daemon_token ? create_daemon_token_state() : undefined
	}))
];

const extra = (name: string, path: string): MiddlewareSpec => ({
	name,
	path,
	handler: async (_c, next) => next()
});

/** The spec named `name` — names are unique in the stack. */
const named = (specs: Array<MiddlewareSpec>, name: string): MiddlewareSpec => {
	const spec = specs.find((s) => s.name === name);
	assert.ok(spec, `no spec named ${name}`);
	return spec;
};

const without = (specs: Array<MiddlewareSpec>, name: string): Array<MiddlewareSpec> =>
	specs.filter((s) => s.name !== name);

const assert_refused = (
	stack: Array<MiddlewareSpec>,
	middleware_specs: Array<MiddlewareSpec>,
	expected: RegExp
): void => {
	assert.throws(() => assert_middleware_stack_mounted(stack, middleware_specs), expected);
};

describe('assert_middleware_stack_mounted — accepted', () => {
	test('the identity transform', async () => {
		const stack = await create_stack(true);
		assert_middleware_stack_mounted(stack, stack);
		assert_middleware_stack_mounted(stack, [...stack]);
	});

	test("a '*' layer before the proxy and an /api/* layer after the auth stack", async () => {
		const stack = await create_stack();
		assert_middleware_stack_mounted(stack, [
			extra('body_cap', '*'),
			...stack,
			extra('token_policy', AUTH_MIDDLEWARE_PATH)
		]);
	});

	test('a layer between the proxy and the auth stack', async () => {
		const stack = await create_stack();
		const [proxy, ...auth] = stack;
		assert_middleware_stack_mounted(stack, [proxy!, extra('between', '*'), ...auth]);
	});

	test('a layer inserted between session and request_context', async () => {
		const stack = await create_stack();
		const [proxy, origin, session, ...rest] = stack;
		assert_middleware_stack_mounted(stack, [
			proxy!,
			origin!,
			session!,
			extra('between', AUTH_MIDDLEWARE_PATH),
			...rest
		]);
	});

	test('a spread copy keeps the handler', async () => {
		const stack = await create_stack();
		assert_middleware_stack_mounted(
			stack,
			stack.map((spec) => ({ ...spec, errors: { ...spec.errors } }))
		);
	});

	test('an empty stack accepts anything', () => {
		assert_middleware_stack_mounted([], [extra('anything', '/elsewhere/*')]);
	});
});

describe('assert_middleware_stack_mounted — refused', () => {
	test('session moved to another path', async () => {
		const stack = await create_stack();
		assert_refused(
			stack,
			stack.map((s) => (s.name === 'session' ? { ...s, path: '/api/v2/*' } : s)),
			/'session' .*\(mounted at \/api\/v2\/\*\)/
		);
	});

	test("origin broadened to '*'", async () => {
		const stack = await create_stack();
		assert_refused(
			stack,
			stack.map((s) => (s.name === 'origin' ? { ...s, path: '*' } : s)),
			/'origin' .*\(mounted at \*\)/
		);
	});

	test('bearer_auth dropped', async () => {
		const stack = await create_stack();
		assert_refused(stack, without(stack, 'bearer_auth'), /'bearer_auth' .*\(missing\)/);
	});

	test('daemon_token dropped when present', async () => {
		const stack = await create_stack(true);
		assert.strictEqual(stack.at(-1)!.name, 'daemon_token');
		assert_refused(stack, stack.slice(0, -1), /'daemon_token' .*\(missing\)/);
	});

	test('session and request_context swapped', async () => {
		const stack = await create_stack();
		const [proxy, origin, session, request_context, ...rest] = stack;
		assert_refused(
			stack,
			[proxy!, origin!, request_context!, session!, ...rest],
			/'request_context' .*\(out of order\)/
		);
	});

	test('origin duplicated', async () => {
		const stack = await create_stack();
		assert_refused(stack, [named(stack, 'origin'), ...stack], /'origin' .*\(mounted 2 times\)/);
	});

	test('a handler wrapped', async () => {
		const stack = await create_stack();
		assert_refused(
			stack,
			stack.map((s) =>
				s.name === 'session' ? { ...s, handler: async (c, next) => s.handler(c, next) } : s
			),
			/'session' .*\(missing\)/
		);
	});

	test('a same-named custom replacement', async () => {
		const stack = await create_stack();
		assert_refused(
			stack,
			stack.map((s) => (s.name === 'origin' ? extra('origin', AUTH_MIDDLEWARE_PATH) : s)),
			/'origin' .*\(missing\)/
		);
	});

	test('the proxy dropped', async () => {
		const stack = await create_stack();
		assert_refused(stack, without(stack, 'trusted_proxy'), /'trusted_proxy' .*\(missing\)/);
	});

	test('the proxy moved after the auth stack', async () => {
		const stack = await create_stack();
		const [proxy, ...auth] = stack;
		assert_refused(stack, [...auth, proxy!], /'origin' .*\(out of order\)/);
	});

	test('the proxy moved between the auth layers', async () => {
		const stack = await create_stack();
		const [proxy, origin, ...rest] = stack;
		assert_refused(stack, [origin!, proxy!, ...rest], /'origin' .*\(out of order\)/);
	});

	test('the proxy duplicated', async () => {
		const stack = await create_stack();
		assert_refused(
			stack,
			[...stack, named(stack, 'trusted_proxy')],
			/'trusted_proxy' .*\(mounted 2 times\)/
		);
	});

	test('the proxy narrowed to the auth path', async () => {
		const stack = await create_stack();
		assert_refused(
			stack,
			stack.map((s) => (s.name === 'trusted_proxy' ? { ...s, path: AUTH_MIDDLEWARE_PATH } : s)),
			/'trusted_proxy' .*\(mounted at \/api\/\*\)/
		);
	});

	test('the proxy replaced by a same-named custom one', async () => {
		const stack = await create_stack();
		assert_refused(
			stack,
			stack.map((s) => (s.name === 'trusted_proxy' ? extra('trusted_proxy', '*') : s)),
			/'trusted_proxy' .*\(missing\)/
		);
	});

	test('the error names the option, the layer, its path, and what to do', async () => {
		const stack = await create_stack();
		assert_refused(
			stack,
			[],
			/^transform_middleware must keep the middleware 'trusted_proxy' mounted once at \* in its original order \(missing\) — .*don't move, drop, wrap, or replace it$/
		);
		assert_refused(
			stack,
			without(stack, 'origin'),
			/^transform_middleware must keep the middleware 'origin' mounted once at \/api\/\* in its original order \(missing\)/
		);
	});
});

describe('create_stub_api_middleware', () => {
	test('each spec has its own handler, none the shared stub_mw', () => {
		const specs = create_stub_api_middleware({ include_daemon_token: true });
		const handlers = new Set(specs.map((s) => s.handler));
		assert.strictEqual(handlers.size, specs.length);
		assert.ok(!handlers.has(stub_mw));
	});

	// the surface merges each middleware's `errors` into every route under its
	// path, so a stub that declared more than the real stack would widen the test
	// surface with statuses the live server never returns
	for (const include_daemon_token of [false, true]) {
		test(`names, paths, and errors match create_auth_middleware_specs (daemon_token: ${include_daemon_token})`, async () => {
			const shape = (specs: Array<MiddlewareSpec>) =>
				specs.map((s) => ({ name: s.name, path: s.path, errors: s.errors ?? null }));
			const real = await create_auth_middleware_specs(create_stub_app_deps(), {
				allowed_origins: [],
				session_options,
				daemon_token_state: include_daemon_token ? create_daemon_token_state() : undefined
			});
			assert.deepStrictEqual(
				shape(create_stub_api_middleware({ include_daemon_token })),
				shape(real)
			);
		});
	}
});

const build_surface = (transform_middleware?: TransformMiddleware) =>
	create_test_app_surface_spec({
		session_options,
		create_route_specs: () => [],
		transform_middleware
	});

describe('create_test_app_surface_spec — transform_middleware', () => {
	test('the middleware list mirrors the real one: the proxy, then the auth stack', () => {
		const names: Array<Array<string>> = [];
		const surface_spec = build_surface((specs) => {
			names.push(specs.map((s) => s.name));
			return specs;
		});
		const expected = ['trusted_proxy', 'origin', 'session', 'request_context', 'bearer_auth'];
		assert.deepStrictEqual(names, [expected]);
		assert.deepStrictEqual(
			surface_spec.surface.middleware.map((m) => m.name),
			expected
		);
		assert.deepStrictEqual(
			build_surface().surface.middleware.map((m) => [m.name, m.path]),
			[['trusted_proxy', '*'], ...expected.slice(1).map((n) => [n, AUTH_MIDDLEWARE_PATH])]
		);
	});

	test('layers around the stack are accepted, including a shared stub_mw', () => {
		const surface_spec = build_surface((specs) => [
			{ name: 'host_validation', path: '*', handler: stub_mw },
			...specs,
			extra('token_policy', AUTH_MIDDLEWARE_PATH)
		]);
		assert.deepStrictEqual(
			surface_spec.surface.middleware.map((m) => m.name),
			[
				'host_validation',
				'trusted_proxy',
				'origin',
				'session',
				'request_context',
				'bearer_auth',
				'token_policy'
			]
		);
	});

	test('a transform dropping an auth spec throws', () => {
		assert.throws(
			() => build_surface((specs) => without(specs, 'session')),
			/transform_middleware must keep the middleware 'session' .*\(missing\)/
		);
	});

	test('a transform dropping the proxy throws', () => {
		assert.throws(
			() => build_surface((specs) => without(specs, 'trusted_proxy')),
			/'trusted_proxy' .*\(missing\)/
		);
	});

	test('a transform moving the proxy after the auth stack throws', () => {
		assert.throws(() => build_surface(([proxy, ...auth]) => [...auth, proxy!]), /out of order/);
	});

	test('a transform duplicating the proxy throws', () => {
		assert.throws(
			() => build_surface((specs) => [...specs, named(specs, 'trusted_proxy')]),
			/'trusted_proxy' .*\(mounted 2 times\)/
		);
	});
});

describe('create_test_app_surface_spec — transform mutating what it was handed', () => {
	test('splicing out session in place', () => {
		assert.throws(
			() =>
				build_surface((specs) => {
					specs.splice(2, 1);
					return specs;
				}),
			/'session' .*\(missing\)/
		);
	});

	test('reversing in place', () => {
		assert.throws(
			() =>
				build_surface((specs) => {
					specs.reverse();
					return specs;
				}),
			/out of order/
		);
	});

	test('emptying in place', () => {
		assert.throws(
			() =>
				build_surface((specs) => {
					specs.length = 0;
					return specs;
				}),
			/'trusted_proxy' .*\(missing\)/
		);
	});

	test('reassigning a path in place', () => {
		assert.throws(
			() =>
				build_surface((specs) => {
					named(specs, 'session').path = '*';
					return specs;
				}),
			/'session' .*\(mounted at \*\)/
		);
	});

	test('wrapping an auth handler in place', () => {
		assert.throws(
			() =>
				build_surface((specs) => {
					const session = named(specs, 'session');
					const inner = session.handler;
					session.handler = async (c, next) => inner(c, next);
					return specs;
				}),
			/'session' .*\(missing\)/
		);
	});

	test('replacing the proxy handler in place', () => {
		assert.throws(
			() =>
				build_surface((specs) => {
					named(specs, 'trusted_proxy').handler = async (_c, next) => next();
					return specs;
				}),
			/'trusted_proxy' .*\(missing\)/
		);
	});
});

const create_server_options = (
	transform_middleware: TransformMiddleware,
	daemon_token_state?: DaemonTokenState
): AppServerOptions => {
	return {
		...create_loopback_app_server_options(),
		backend: create_stub_app_backend(),
		session_options,
		create_route_specs: () => [create_health_route_spec()],
		rate_limiters: 'disabled_for_testing',
		daemon_token_state,
		transform_middleware
	};
};

/** Resolve to the error assembly threw, or `null` when it succeeded (the server is closed). */
const assemble = async (options: AppServerOptions): Promise<unknown> => {
	try {
		const server = await create_app_server(options);
		await server.close();
		return null;
	} catch (error) {
		return error;
	}
};

const assert_assembly_refused = async (
	options: AppServerOptions,
	expected: RegExp
): Promise<void> => {
	const thrown = await assemble(options);
	assert.instanceOf(thrown, Error);
	assert.match(thrown.message, expected);
};

describe('create_app_server — transform_middleware', () => {
	test('a layer before the proxy and one after the auth stack are accepted', async () => {
		const thrown = await assemble(
			create_server_options((specs) => [
				extra('body_cap', '*'),
				...specs,
				extra('token_policy', AUTH_MIDDLEWARE_PATH)
			])
		);
		assert.isNull(thrown);
	});

	test('the transform receives the proxy and auth specs, daemon_token included', async () => {
		const received: Array<Array<MiddlewareSpec>> = [];
		const thrown = await assemble(
			create_server_options((specs) => {
				received.push(specs);
				return specs;
			}, create_daemon_token_state())
		);
		assert.isNull(thrown);
		assert.deepStrictEqual(
			received[0]!.map((s) => s.name),
			['trusted_proxy', 'origin', 'session', 'request_context', 'bearer_auth', 'daemon_token']
		);
	});

	test('dropping the proxy throws', async () => {
		await assert_assembly_refused(
			create_server_options((specs) => without(specs, 'trusted_proxy')),
			/'trusted_proxy' .*\(missing\)/
		);
	});

	test('moving the proxy after the auth stack throws', async () => {
		await assert_assembly_refused(
			create_server_options(([proxy, ...auth]) => [...auth, proxy!]),
			/out of order/
		);
	});

	test('dropping daemon_token when daemon_token_state is set throws', async () => {
		await assert_assembly_refused(
			create_server_options((specs) => without(specs, 'daemon_token'), create_daemon_token_state()),
			/'daemon_token' .*\(missing\)/
		);
	});
});

describe('create_app_server — transform mutating what it was handed', () => {
	test('wrapping an auth handler in place', async () => {
		await assert_assembly_refused(
			create_server_options((specs) => {
				const session = named(specs, 'session');
				const inner = session.handler;
				session.handler = async (c, next) => inner(c, next);
				return specs;
			}),
			/'session' .*\(missing\)/
		);
	});

	test('replacing an auth handler in place with a pass-through', async () => {
		await assert_assembly_refused(
			create_server_options((specs) => {
				named(specs, 'origin').handler = async (_c, next) => next();
				return specs;
			}),
			/'origin' .*\(missing\)/
		);
	});

	test('replacing the proxy handler in place', async () => {
		await assert_assembly_refused(
			create_server_options((specs) => {
				named(specs, 'trusted_proxy').handler = async (_c, next) => next();
				return specs;
			}),
			/'trusted_proxy' .*\(missing\)/
		);
	});

	test('reassigning the proxy path in place', async () => {
		await assert_assembly_refused(
			create_server_options((specs) => {
				named(specs, 'trusted_proxy').path = AUTH_MIDDLEWARE_PATH;
				return specs;
			}),
			/'trusted_proxy' .*\(mounted at \/api\/\*\)/
		);
	});

	test('splicing out session in place', async () => {
		await assert_assembly_refused(
			create_server_options((specs) => {
				specs.splice(
					specs.findIndex((s) => s.name === 'session'),
					1
				);
				return specs;
			}),
			/'session' .*\(missing\)/
		);
	});
});
