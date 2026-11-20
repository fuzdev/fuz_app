/**
 * The raw answers `prepare_route_response` refuses, and some it admits — built
 * fresh on each call, since a stream or a buffer can be used once. Shared by
 * the prepare's own rows (`route_result.test.ts`) and the route-level rows
 * that pin each refusal before the commit (`route_result.refusal.db.test.ts`).
 *
 * @module
 */

import type { RouteRawInit } from '#lib/http/route_result.ts';

const one_chunk = (): ReadableStream<Uint8Array> =>
	new ReadableStream<Uint8Array>({
		start: (controller) => {
			controller.enqueue(new Uint8Array([65]));
			controller.close();
		}
	});

const TEXT = { 'Content-Type': 'text/plain' } as const;

const locked_stream = (): ReadableStream<Uint8Array> => {
	const body = one_chunk();
	body.getReader();
	return body;
};

const detached_bytes = (): Uint8Array => {
	const body = new Uint8Array([1, 2, 3]);
	body.buffer.transfer();
	return body;
};

/** The raw answers the prepare refuses, by name, built fresh on each call. */
export const route_raw_refusals = (): Array<[name: string, init: unknown]> => [
	['refused_set_cookie', { status: 200, headers: { 'Set-Cookie': 'x=1' } }],
	['refused_connection', { status: 200, headers: { connection: 'close' } }],
	['refused_transfer_encoding', { status: 200, headers: { 'Transfer-Encoding': 'chunked' } }],
	['refused_upgrade', { status: 200, headers: { Upgrade: 'websocket' } }],
	['body_without_content_type', { status: 200, body: 'x' }],
	['body_on_204', { status: 204, headers: TEXT, body: 'x' }],
	['body_on_205', { status: 205, headers: TEXT, body: 'x' }],
	['body_on_304', { status: 304, headers: TEXT, body: '' }],
	['status_101', { status: 101 }],
	['status_199', { status: 199 }],
	['status_600', { status: 600 }],
	['status_fraction', { status: 200.5 }],
	['response_body', { status: 200, headers: TEXT, body: new Response('x') }],
	['duplicate_name', { status: 200, headers: { 'X-A': '1', 'x-a': '2' } }],
	['bad_header_value', { status: 200, headers: { 'X-A': 'a\nb' } }],
	['bad_header_name', { status: 200, headers: { 'X A': '1' } }],
	['non_string_header', { status: 200, headers: { 'X-A': 1 } }],
	['empty_header_value', { status: 200, headers: { 'Content-Type': '' }, body: 'x' }],
	['empty_header_in_list', { status: 200, headers: { 'X-A': ['a', ''] } }],
	['empty_header_list', { status: 200, headers: { 'X-A': [] } }],
	[
		'content_length_non_numeric',
		{ status: 200, headers: { ...TEXT, 'Content-Length': 'abc' }, body: 'hello' }
	],
	[
		'content_length_signed',
		{ status: 200, headers: { ...TEXT, 'Content-Length': '+5' }, body: 'hello' }
	],
	[
		'content_length_list',
		{ status: 200, headers: { ...TEXT, 'Content-Length': ['5', '6'] }, body: 'hello' }
	],
	[
		// a list is no single value, even of one
		'content_length_one_item_list',
		{ status: 200, headers: { ...TEXT, 'Content-Length': ['5'] }, body: 'hello' }
	],
	[
		'content_length_string_mismatch',
		{ status: 200, headers: { ...TEXT, 'Content-Length': '2' }, body: 'hello world' }
	],
	[
		// UTF-8 bytes, not code units: `é` is two
		'content_length_string_code_units',
		{ status: 200, headers: { ...TEXT, 'Content-Length': '1' }, body: 'é' }
	],
	[
		'content_length_bytes_mismatch',
		{
			status: 200,
			headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '4' },
			body: new Uint8Array([1, 2, 3])
		}
	],
	['locked_stream', { status: 200, headers: TEXT, body: locked_stream() }],
	[
		'detached_bytes',
		{ status: 200, headers: { 'Content-Type': 'application/octet-stream' }, body: detached_bytes() }
	]
];

/**
 * Raw answers the prepare admits that a stricter rule could wrongly refuse,
 * built fresh on each call.
 */
export const route_raw_admitted = (): Array<[name: string, init: RouteRawInit]> => [
	// a size declared with no body in hand: `HEAD`, `X-Accel-Redirect`
	['content_length_null_body', { status: 200, headers: { 'Content-Length': '9' } }],
	[
		'content_length_stream_body',
		{ status: 200, headers: { ...TEXT, 'Content-Length': '1' }, body: one_chunk() }
	],
	['content_length_utf8', { status: 200, headers: { ...TEXT, 'content-length': '2' }, body: 'é' }],
	[
		'content_length_bytes',
		{
			status: 200,
			headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '3' },
			body: new Uint8Array([1, 2, 3])
		}
	]
];
