/**
 * Tests for `create_throwing_api` — typed Proxy wrapper that flips
 * `Promise<Result<{value: T}>>` to `Promise<T>` and throws on the error
 * branch.
 *
 * Naming convention: the underlying Result-returning Proxy is `api_result`
 * (matches `create_frontend_rpc_client`'s field name); the throwing wrapper
 * is `api`. Tests mirror the call-site shape consumers will use.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';
import type {Result} from '@fuzdev/fuz_util/result.js';
import {assert_rejects} from '@fuzdev/fuz_util/testing.js';

import {create_throwing_api, type ThrowingApi} from '$lib/actions/rpc_client.js';
import type {JsonrpcErrorObject} from '$lib/http/jsonrpc.js';

describe('create_throwing_api', () => {
	test('unwraps {ok: true, value} to value via the typed Proxy', async () => {
		const api_result = {
			foo: async (_input?: unknown) => ({ok: true as const, value: {hello: 'world'}}),
		};
		const api = create_throwing_api(api_result);
		assert.deepStrictEqual(await api.foo(), {hello: 'world'});
	});

	test('forwards input + options to the underlying method', async () => {
		const received: Array<Array<unknown>> = [];
		const api_result = {
			foo: async (input?: unknown, options?: unknown) => {
				received.push([input, options]);
				return {ok: true as const, value: 1};
			},
		};
		const api = create_throwing_api(api_result);
		await api.foo({a: 1}, {signal: undefined, transport_name: 'mock'});
		assert.deepStrictEqual(received, [[{a: 1}, {signal: undefined, transport_name: 'mock'}]]);
	});

	test('throws Error with {code, data} spread + message from error.message on {ok: false}', async () => {
		const api_result = {
			foo: async () => ({
				ok: false as const,
				error: {code: -32002, message: 'forbidden', data: {reason: 'offer_not_authorized'}},
			}),
		};
		const api = create_throwing_api(api_result);
		const err = (await assert_rejects(() => api.foo())) as Error & {
			code?: number;
			data?: {reason?: string};
		};
		assert.strictEqual(err.message, 'forbidden');
		assert.strictEqual(err.code, -32002);
		// Optional chaining required because JSON-RPC `data` is spec-level optional.
		assert.strictEqual(err.data?.reason, 'offer_not_authorized');
	});

	test('optional chaining on err.data works when data is missing', async () => {
		const api_result = {
			// `jsonrpc_errors.forbidden()` with no `data` argument produces this shape.
			foo: async () => ({ok: false as const, error: {code: -32002, message: 'forbidden'}}),
		};
		const api = create_throwing_api(api_result);
		const err = (await assert_rejects(() => api.foo())) as Error & {
			code?: number;
			data?: {reason?: string};
		};
		assert.strictEqual(err.code, -32002);
		assert.strictEqual(err.data?.reason, undefined);
	});

	test('attacker-shaped result.error cannot overwrite Error.stack / .name', async () => {
		// Same hardening as `create_throwing_rpc_call` — only {code, data}
		// cross onto the thrown Error; native `name` / `stack` stay intact.
		const api_result = {
			foo: async () => ({
				ok: false as const,
				error: {
					code: -32002,
					message: 'forbidden',
					data: {reason: 'offer_not_authorized'},
					stack: 'Error: not-a-real-stack\n    at fake.ts:1:1',
					name: 'AttackerControlledName',
					cause: 'synthetic',
				},
			}),
		};
		const api = create_throwing_api(api_result);
		const err = (await assert_rejects(() => api.foo())) as Error & {
			code?: number;
			cause?: unknown;
		};
		assert.strictEqual(err.name, 'Error', 'Error.name must not be overwritable');
		assert.ok(
			typeof err.stack === 'string' && !err.stack.includes('not-a-real-stack'),
			'Error.stack must be the native JS stack, not the attacker payload',
		);
		assert.strictEqual(
			err.cause,
			undefined,
			'Only {code, data} are spread; extras must not land on the Error',
		);
		assert.strictEqual(err.message, 'forbidden');
		assert.strictEqual(err.code, -32002);
	});

	test('passes through non-Result returns unchanged (sync local_call shape)', async () => {
		// `create_sync_local_call_method` returns the raw value, not a Result.
		// The Proxy can't introspect spec.kind, so it inspects result shape
		// at call-time. Non-object returns pass through; the await still
		// wraps in a Promise so the runtime type widens to Promise<value>
		// for sync local_calls — known minor type/runtime divergence.
		const api_result = {sync_value: () => 42};
		const api = create_throwing_api(api_result);
		assert.strictEqual(await (api as any).sync_value(), 42);
	});

	test('non-function properties pass through', async () => {
		const api_result = {meta: 'static-string', toggle: () => true};
		const api = create_throwing_api(api_result);
		assert.strictEqual((api as any).meta, 'static-string');
		assert.strictEqual(await (api as any).toggle(), true);
	});

	test('works against a Proxy-shaped underlying api (matches create_rpc_client)', async () => {
		// `create_rpc_client` itself returns a Proxy with no concrete keys.
		// `create_throwing_api` must work over that — the underlying Proxy's
		// `get` runs first, then ours wraps the returned function.
		const inner = new Proxy(
			{},
			{
				get: (_t, prop: string) =>
					prop === 'known' ? async () => ({ok: true, value: 'yes'}) : undefined,
			},
		) as Record<string, (input?: any) => Promise<any>>;
		const api = create_throwing_api(inner);
		assert.strictEqual(await (api as any).known(), 'yes');
	});

	test('unknown string-keyed method throws "rpc method not found" on call', () => {
		// Sync throw at invocation, NOT a rejection — the thrower fires at
		// the call site so probing the shape (`typeof api.missing ===
		// 'function'`) doesn't blow up. `assert_rejects` is for async
		// rejections; this is the synchronous symmetric case.
		const api = create_throwing_api({});
		assert.strictEqual(typeof (api as any).missing, 'function');
		assert.throws(() => (api as any).missing(), /rpc method not found: missing/);
	});

	test('await api resolves without invoking the thrower (then stays undefined)', async () => {
		// `await x` on a non-thenable resolves to `x`. The Proxy must NOT
		// return a thrower for `then` — otherwise the await machinery would
		// call `api.then(resolve, reject)` and explode.
		const api = create_throwing_api({});
		assert.strictEqual((api as any).then, undefined);
		assert.strictEqual(await (api as any), api);
	});

	test('symbol-keyed access stays undefined (no thrower)', () => {
		// Same reasoning as `then` — async iteration / well-known symbols
		// must probe cleanly.
		const api = create_throwing_api({});
		assert.strictEqual((api as any)[Symbol.iterator], undefined);
		assert.strictEqual((api as any)[Symbol.asyncIterator], undefined);
	});
});

describe('ThrowingApi<TApi> — type-only fixtures', () => {
	// These assertions live at compile time. If `ThrowingApi<>` regresses
	// (e.g. someone breaks the mapped-type inference for `TInput` / `TOptions`
	// / `TValue`), the type assertions below stop compiling and `gro check`
	// fails before any runtime test runs.
	test('strips Promise<Result<{value: T}>> to Promise<T>', () => {
		interface SampleApi {
			account_verify: (
				input?: undefined,
				options?: {signal?: AbortSignal},
			) => Promise<Result<{value: {id: string}}, {error: JsonrpcErrorObject}>>;
			notify: (input: {x: number}) => void;
		}

		type Throwing = ThrowingApi<SampleApi>;

		// `account_verify`: return type unwrapped, params + options preserved.
		const verify_check: Throwing['account_verify'] = async (
			_input?: undefined,
			_options?: {signal?: AbortSignal},
		): Promise<{id: string}> => ({id: 'a'});
		void verify_check;

		// `notify`: pass-through arm — original signature preserved unchanged.
		const notify_check: Throwing['notify'] = (_input: {x: number}): void => undefined;
		void notify_check;

		assert.ok(true, 'type assertions above are the actual test');
	});
});
