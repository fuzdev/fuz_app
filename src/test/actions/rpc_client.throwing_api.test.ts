/**
 * Tests for `create_throwing_api` — typed Proxy wrapper that flips
 * `Promise<Result<{value: T}>>` to `Promise<T>` and throws on the error
 * branch.
 *
 * Variable convention follows the recommended consumer pattern: the
 * underlying Result-returning Proxy is bound to `api_raw`, the
 * throwing wrapper to `api`. Tests model the call-site shape consumers
 * will use.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';
import type {Result} from '@fuzdev/fuz_util/result.js';

import {create_throwing_api, type ThrowingApi} from '$lib/actions/rpc_client.js';
import type {JsonrpcErrorObject} from '$lib/http/jsonrpc.js';

describe('create_throwing_api', () => {
	test('unwraps {ok: true, value} to value via the typed Proxy', async () => {
		const api_raw = {
			foo: async (_input?: unknown) => ({ok: true as const, value: {hello: 'world'}}),
		};
		const api = create_throwing_api(api_raw);
		const result = await api.foo();
		assert.deepStrictEqual(result, {hello: 'world'});
	});

	test('forwards input + options to the underlying method', async () => {
		const received: Array<Array<unknown>> = [];
		const api_raw = {
			foo: async (input?: unknown, options?: unknown) => {
				received.push([input, options]);
				return {ok: true as const, value: 1};
			},
		};
		const api = create_throwing_api(api_raw);
		await api.foo({a: 1}, {signal: undefined, transport_name: 'mock'});
		assert.deepStrictEqual(received, [[{a: 1}, {signal: undefined, transport_name: 'mock'}]]);
	});

	test('throws Error with {code, data} spread + message from error.message on {ok: false}', async () => {
		const api_raw = {
			foo: async () => ({
				ok: false as const,
				error: {code: -32002, message: 'forbidden', data: {reason: 'offer_not_authorized'}},
			}),
		};
		const api = create_throwing_api(api_raw);
		let caught: unknown;
		try {
			await api.foo();
		} catch (err) {
			caught = err;
		}
		assert.ok(caught instanceof Error, 'caught must be an Error');
		assert.strictEqual(caught.message, 'forbidden');
		assert.strictEqual((caught as {code?: number}).code, -32002);
		// Optional chaining required because JSON-RPC `data` is spec-level optional.
		assert.strictEqual((caught as {data?: {reason?: string}}).data?.reason, 'offer_not_authorized');
	});

	test('optional chaining on err.data works when data is missing', async () => {
		const api_raw = {
			foo: async () => ({
				ok: false as const,
				// `jsonrpc_errors.forbidden()` with no `data` argument produces this shape.
				error: {code: -32002, message: 'forbidden'},
			}),
		};
		const api = create_throwing_api(api_raw);
		let caught: unknown;
		try {
			await api.foo();
		} catch (err) {
			caught = err;
		}
		assert.ok(caught instanceof Error);
		assert.strictEqual((caught as {data?: {reason?: string}}).data?.reason, undefined);
		assert.strictEqual((caught as {code?: number}).code, -32002);
	});

	test('attacker-shaped result.error cannot overwrite Error.stack / .name', async () => {
		// Same hardening as `create_throwing_rpc_call` — only {code, data}
		// cross onto the thrown Error; native `name` / `stack` stay intact.
		const api_raw = {
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
		const api = create_throwing_api(api_raw);
		let caught: unknown;
		try {
			await api.foo();
		} catch (err) {
			caught = err;
		}
		assert.ok(caught instanceof Error);
		assert.strictEqual(caught.name, 'Error', 'Error.name must not be overwritable');
		assert.ok(
			typeof caught.stack === 'string' && !caught.stack.includes('not-a-real-stack'),
			'Error.stack must be the native JS stack, not the attacker payload',
		);
		assert.strictEqual(
			(caught as {cause?: unknown}).cause,
			undefined,
			'Only {code, data} are spread; extras must not land on the Error',
		);
		assert.strictEqual(caught.message, 'forbidden');
		assert.strictEqual((caught as {code?: number}).code, -32002);
	});

	test('passes through non-Result returns unchanged (sync local_call shape)', async () => {
		// `create_sync_local_call_method` returns the raw value, not a Result.
		// The Proxy can't introspect spec.kind, so it inspects result shape
		// at call-time. Non-object returns pass through; the await still
		// wraps in a Promise so the runtime type widens to Promise<value>
		// for sync local_calls — known minor type/runtime divergence.
		const api_raw = {sync_value: () => 42};
		const api = create_throwing_api(api_raw);
		assert.strictEqual(await (api as any).sync_value(), 42);
	});

	test('non-function properties pass through', async () => {
		const api_raw = {meta: 'static-string', toggle: () => true};
		const api = create_throwing_api(api_raw);
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

	test('unknown string-keyed method throws "rpc method not found" on call', async () => {
		// Symmetric with `create_throwing_rpc_call('missing')`. The thrower
		// fires at invocation time, not at property access — so probing the
		// shape (`typeof api.missing === 'function'`) doesn't blow up.
		const api = create_throwing_api({});
		assert.strictEqual(typeof (api as any).missing, 'function');
		let caught: unknown;
		try {
			(api as any).missing();
		} catch (err) {
			caught = err;
		}
		assert.ok(caught instanceof Error);
		assert.match(caught.message, /rpc method not found: missing/);
	});

	test('await api resolves without invoking the thrower (then stays undefined)', async () => {
		// `await x` on a non-thenable resolves to `x`. The Proxy must NOT
		// return a thrower for `then` — otherwise the await machinery would
		// call `api.then(resolve, reject)` and explode.
		const api = create_throwing_api({});
		assert.strictEqual((api as any).then, undefined);
		const resolved = await (api as any);
		assert.strictEqual(resolved, api);
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
