/**
 * Tests for `FrontendHttpTransport` — the `fetch` adapter's handling of
 * JSON-RPC error bodies on non-2xx responses, the headers it sends, and the
 * `GET`/`POST` choice it derives from each method's spec.
 *
 * @module
 */

import { describe, assert, test, vi, afterEach } from 'vitest';
import { z } from 'zod';

import { DEFAULT_MAX_GET_URL_LENGTH, FrontendHttpTransport } from '#lib/actions/transports_http.ts';
import type { ActionSpecUnion } from '#lib/actions/action_spec.ts';
import { JSONRPC_ERROR_CODES } from '#lib/http/jsonrpc_errors.ts';
import { is_jsonrpc_error_response } from '#lib/http/jsonrpc_helpers.ts';
import type { JsonrpcRequest } from '#lib/http/jsonrpc.ts';

afterEach(() => {
	vi.restoreAllMocks();
});

const request: JsonrpcRequest = { jsonrpc: '2.0', id: 'req-1', method: 'terminal_data_send' };

/** Stub `fetch` with one response. */
const stub_fetch = (body: string, status: number, status_text = ''): void => {
	vi.spyOn(globalThis, 'fetch').mockResolvedValue(
		new Response(body, { status, statusText: status_text })
	);
};

/** A `request_response` spec for `method`. */
const create_spec = (
	method: string,
	side_effects: boolean,
	input: z.ZodType = z.strictObject({}).optional()
): ActionSpecUnion => ({
	method,
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'none', actor: 'none' },
	side_effects,
	input,
	output: z.null(),
	async: true,
	description: method
});

/** A `lookup_action_spec` over `specs`. */
const lookup_of =
	(...specs: Array<ActionSpecUnion>) =>
	(method: string): ActionSpecUnion | undefined =>
		specs.find((spec) => spec.method === method);

/** The lookup of a transport whose calls never go as a `GET`. */
const no_specs = (): undefined => undefined;

/** A read with no sensitive input. */
const thing_get = create_spec('thing_get', false);

/** A transport for `/api/rpc` that knows no specs, so every call is a `POST`. */
const create_transport = (): FrontendHttpTransport =>
	new FrontendHttpTransport({ url: '/api/rpc', lookup_action_spec: no_specs });

const error_body = (id: unknown, code: number, message: string, data?: unknown): string =>
	JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data } });

describe('FrontendHttpTransport non-2xx responses', () => {
	test('returns the server error body as-is, keeping code, message, and data', async () => {
		stub_fetch(
			error_body('req-1', JSONRPC_ERROR_CODES.queue_overflow, 'terminal input full', {
				reason: 'full'
			}),
			429
		);
		const transport = create_transport();
		const response = await transport.send(request);
		assert.ok(is_jsonrpc_error_response(response));
		assert.strictEqual(response.id, 'req-1');
		assert.strictEqual(response.error.code, JSONRPC_ERROR_CODES.queue_overflow);
		assert.strictEqual(response.error.message, 'terminal input full');
		assert.deepEqual(response.error.data, { reason: 'full' });
	});

	test('keeps a server message the status map would have lost', async () => {
		stub_fetch(
			error_body('req-1', JSONRPC_ERROR_CODES.internal_error, 'provider: invalid key'),
			500
		);
		const response = await create_transport().send(request);
		assert.ok(is_jsonrpc_error_response(response));
		assert.strictEqual(response.error.message, 'provider: invalid key');
	});

	test('accepts a null id (the server could not read the request id)', async () => {
		stub_fetch(error_body(null, JSONRPC_ERROR_CODES.parse_error, 'parse error'), 400);
		const response = await create_transport().send(request);
		assert.ok(is_jsonrpc_error_response(response));
		assert.strictEqual(response.error.code, JSONRPC_ERROR_CODES.parse_error);
		assert.strictEqual(response.error.message, 'parse error');
	});

	test('matches a numeric id the server echoes as a string (GET query param)', async () => {
		stub_fetch(error_body('5', JSONRPC_ERROR_CODES.not_found, 'no such thing'), 404);
		const transport = new FrontendHttpTransport({
			url: '/api/rpc',
			lookup_action_spec: lookup_of(thing_get)
		});
		const response = await transport.send({ jsonrpc: '2.0', id: 5, method: 'thing_get' });
		assert.ok(is_jsonrpc_error_response(response));
		assert.strictEqual(response.error.message, 'no such thing');
		const url = vi.mocked(globalThis.fetch).mock.calls[0]![0] as string;
		assert.include(url, 'id=5');
	});

	test('synthesizes from the status when the body answers a different id', async () => {
		stub_fetch(error_body('other', JSONRPC_ERROR_CODES.forbidden, 'not yours'), 401);
		const response = await create_transport().send(request);
		assert.ok(is_jsonrpc_error_response(response));
		assert.strictEqual(response.id, 'req-1');
		assert.strictEqual(response.error.code, JSONRPC_ERROR_CODES.unauthenticated);
		assert.strictEqual(response.error.message, 'HTTP error: 401');
	});

	test('synthesizes from the status for a non-JSON body', async () => {
		stub_fetch('<html>bad gateway</html>', 503, 'Service Unavailable');
		const response = await create_transport().send(request);
		assert.ok(is_jsonrpc_error_response(response));
		assert.strictEqual(response.id, 'req-1');
		assert.strictEqual(response.error.code, JSONRPC_ERROR_CODES.service_unavailable);
		assert.strictEqual(response.error.message, 'HTTP error: 503 Service Unavailable');
	});

	test('synthesizes from the status for an empty body', async () => {
		stub_fetch('', 404);
		const response = await create_transport().send(request);
		assert.ok(is_jsonrpc_error_response(response));
		assert.strictEqual(response.error.code, JSONRPC_ERROR_CODES.not_found);
	});

	test('synthesizes from the status for a malformed error object', async () => {
		stub_fetch(JSON.stringify({ jsonrpc: '2.0', id: 'req-1', error: { code: 'x' } }), 500);
		const response = await create_transport().send(request);
		assert.ok(is_jsonrpc_error_response(response));
		assert.strictEqual(response.error.code, JSONRPC_ERROR_CODES.internal_error);
		assert.strictEqual(response.error.message, 'HTTP error: 500');
	});

	test('DEV warns when the error code does not map to the response status', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		stub_fetch(error_body('req-1', JSONRPC_ERROR_CODES.not_found, 'nope'), 500);
		const response = await create_transport().send(request);
		assert.ok(is_jsonrpc_error_response(response));
		assert.strictEqual(response.error.code, JSONRPC_ERROR_CODES.not_found);
		assert.strictEqual(warn.mock.calls.length, 1);
	});

	test('no DEV warning when a shared status is correct for the code', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		stub_fetch(error_body('req-1', JSONRPC_ERROR_CODES.queue_overflow, 'full'), 429);
		await create_transport().send(request);
		assert.strictEqual(warn.mock.calls.length, 0);
	});
});

describe('FrontendHttpTransport 2xx responses', () => {
	test('returns the success body', async () => {
		stub_fetch(JSON.stringify({ jsonrpc: '2.0', id: 'req-1', result: { ok: 1 } }), 200);
		const response = await create_transport().send(request);
		assert.ok('result' in response);
		assert.deepEqual(response.result, { ok: 1 });
	});
});

describe('FrontendHttpTransport 2xx bodies', () => {
	test('a JSON-RPC response passes through', async () => {
		stub_fetch(JSON.stringify({ jsonrpc: '2.0', id: 'req-1', result: null }), 200);
		const response = await create_transport().send(request);
		assert.deepStrictEqual(response, { jsonrpc: '2.0', id: 'req-1', result: null });
	});

	test('a non-JSON body is an internal_error naming the status and content type', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response('<!doctype html><title>app</title>', {
				status: 200,
				headers: { 'content-type': 'text/html' }
			})
		);
		const response = await create_transport().send(request);
		assert.ok(is_jsonrpc_error_response(response));
		assert.strictEqual(response.id, 'req-1');
		assert.strictEqual(response.error.code, JSONRPC_ERROR_CODES.internal_error);
		assert.strictEqual(response.error.message, 'response is not JSON-RPC: HTTP 200 text/html');
	});

	test('JSON that is not a JSON-RPC response is an internal_error', async () => {
		stub_fetch(JSON.stringify({ ok: true }), 200);
		const response = await create_transport().send(request);
		assert.ok(is_jsonrpc_error_response(response));
		assert.include(response.error.message, 'response is not JSON-RPC: HTTP 200');
	});
});

describe('FrontendHttpTransport headers', () => {
	const sent_headers = (): Record<string, string> =>
		vi.mocked(globalThis.fetch).mock.calls[0]![1]!.headers as Record<string, string>;

	test('extra headers keep the JSON content type', async () => {
		stub_fetch(JSON.stringify({ jsonrpc: '2.0', id: 'req-1', result: null }), 200);
		await new FrontendHttpTransport({
			url: '/api/rpc',
			headers: { Authorization: 'Bearer x' },
			lookup_action_spec: no_specs
		}).send(request);
		assert.deepEqual(sent_headers(), {
			'content-type': 'application/json',
			accept: 'application/json',
			authorization: 'Bearer x'
		});
	});

	test('a caller header replaces a default whatever its case', async () => {
		stub_fetch(JSON.stringify({ jsonrpc: '2.0', id: 'req-1', result: null }), 200);
		await new FrontendHttpTransport({
			url: '/api/rpc',
			headers: { 'Content-Type': 'application/json; charset=utf-8' },
			lookup_action_spec: no_specs
		}).send(request);
		assert.strictEqual(sent_headers()['content-type'], 'application/json; charset=utf-8');
		assert.notProperty(sent_headers(), 'Content-Type');
	});
});

describe('FrontendHttpTransport GET reads', () => {
	const ok_body = (id: unknown): string => JSON.stringify({ jsonrpc: '2.0', id, result: null });
	const sent = (): { url: string; init: RequestInit } => {
		const call = vi.mocked(globalThis.fetch).mock.calls[0]!;
		return { url: call[0] as string, init: call[1]! };
	};
	const read = (params?: unknown): JsonrpcRequest => ({
		jsonrpc: '2.0',
		id: 'r1',
		method: 'thing_get',
		...(params === undefined ? {} : { params: params as JsonrpcRequest['params'] })
	});

	test('a read is a GET with the envelope in the query and no content type', async () => {
		stub_fetch(ok_body('r1'), 200);
		await new FrontendHttpTransport({
			url: '/api/rpc',
			lookup_action_spec: lookup_of(thing_get)
		}).send(read({ id: 'x' }));
		const { url, init } = sent();
		assert.strictEqual(init.method, 'GET');
		assert.strictEqual(init.body, undefined);
		const query = new URL(url, 'http://localhost').searchParams;
		assert.strictEqual(query.get('method'), 'thing_get');
		assert.strictEqual(query.get('id'), 'r1');
		assert.strictEqual(query.get('params'), '{"id":"x"}');
		assert.deepEqual(init.headers, { accept: 'application/json' });
	});

	test('a method with side effects is a POST', async () => {
		stub_fetch(ok_body('r1'), 200);
		await new FrontendHttpTransport({
			url: '/api/rpc',
			lookup_action_spec: lookup_of(create_spec('thing_get', true))
		}).send(read({ id: 'x' }));
		const { url, init } = sent();
		assert.strictEqual(init.method, 'POST');
		assert.strictEqual(url, '/api/rpc');
	});

	test('a method the lookup does not know is a POST', async () => {
		stub_fetch(ok_body('r1'), 200);
		await new FrontendHttpTransport({
			url: '/api/rpc',
			lookup_action_spec: lookup_of(create_spec('other_get', false))
		}).send(read({ id: 'x' }));
		assert.strictEqual(sent().init.method, 'POST');
	});

	test('a read whose input carries a sensitive value at any depth is a POST', async () => {
		const sensitive_inputs: Array<z.ZodType> = [
			z.strictObject({ token: z.string().meta({ sensitivity: 'secret' }) }),
			z
				.strictObject({
					filter: z
						.strictObject({
							emails: z.array(z.string().meta({ sensitivity: 'personal' }))
						})
						.optional()
				})
				.optional()
		];
		for (const input of sensitive_inputs) {
			vi.restoreAllMocks();
			stub_fetch(ok_body('r1'), 200);
			await new FrontendHttpTransport({
				url: '/api/rpc',
				lookup_action_spec: lookup_of(create_spec('thing_get', false, input))
			}).send(read({ token: 'hunter2' }));
			const { url, init } = sent();
			assert.strictEqual(init.method, 'POST');
			assert.notInclude(url, 'hunter2', 'the value stays out of the URL');
			assert.include(init.body as string, 'hunter2');
		}
	});

	test('the sensitive check walks each spec once', async () => {
		const input = z.strictObject({ token: z.string().meta({ sensitivity: 'secret' }) });
		const spec = create_spec('thing_get', false, input);
		const lookup = vi.fn(lookup_of(spec));
		const transport = new FrontendHttpTransport({ url: '/api/rpc', lookup_action_spec: lookup });
		// a getter on the spec's input counts the walks
		let walks = 0;
		Object.defineProperty(spec, 'input', {
			get: () => {
				walks++;
				return input;
			}
		});
		const fetch_spy = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () => new Response(ok_body('r1'), { status: 200 }));
		for (let i = 0; i < 3; i++) await transport.send(read({ token: 'x' }));
		assert.deepEqual(
			fetch_spy.mock.calls.map((call) => call[1]!.method),
			['POST', 'POST', 'POST']
		);
		assert.strictEqual(walks, 1);
		assert.strictEqual(lookup.mock.calls.length, 3, 'the spec is looked up per call');
	});

	test('a read whose path and query run past max_get_url_length is a POST, at the limit a GET', async () => {
		const url = '/api/rpc';
		// the path and query of a GET carrying `pad`
		const get_length = (pad: string): number => {
			const q = new URLSearchParams();
			q.set('method', 'thing_get');
			q.set('id', 'r1');
			q.set('params', JSON.stringify({ pad }));
			return url.length + 1 + q.toString().length;
		};
		const fill = 'a'.repeat(DEFAULT_MAX_GET_URL_LENGTH - get_length(''));
		assert.strictEqual(get_length(fill), DEFAULT_MAX_GET_URL_LENGTH);
		const transport = new FrontendHttpTransport({ url, lookup_action_spec: lookup_of(thing_get) });

		stub_fetch(ok_body('r1'), 200);
		await transport.send(read({ pad: fill }));
		assert.strictEqual(sent().init.method, 'GET', 'at the limit');

		vi.restoreAllMocks();
		stub_fetch(ok_body('r1'), 200);
		await transport.send(read({ pad: fill + 'a' }));
		assert.strictEqual(sent().init.method, 'POST', 'one past it');
	});

	test('max_get_url_length is configurable and measures the path and query, not the origin', async () => {
		const transport = new FrontendHttpTransport({
			url: 'https://a-long-origin-name.example.com/api/rpc',
			lookup_action_spec: lookup_of(thing_get),
			max_get_url_length: 60
		});
		stub_fetch(ok_body('r1'), 200);
		await transport.send(read());
		// `/api/rpc?method=thing_get&id=r1` is under 60; the origin does not count
		assert.strictEqual(sent().init.method, 'GET');

		vi.restoreAllMocks();
		stub_fetch(ok_body('r1'), 200);
		await transport.send(read({ pad: 'x'.repeat(40) }));
		assert.strictEqual(sent().init.method, 'POST');
	});

	test('a notification is a POST even for a read', async () => {
		stub_fetch('', 200);
		await new FrontendHttpTransport({
			url: '/api/rpc',
			lookup_action_spec: lookup_of(thing_get)
		}).send({
			jsonrpc: '2.0',
			method: 'thing_get'
		});
		assert.strictEqual(sent().init.method, 'POST');
	});
});
