/**
 * What a route handler returns: a success, a failure, a raw answer described
 * as data, or an SSE stream. A handler never builds a `Response`:
 * `apply_route_specs` prepares the response from the result inside the
 * route's transaction and builds it only after the commit, through the Hono
 * context (`prepare_route_response`, `emit_route_response` in
 * `http/route_spec.ts`). So every response a route spec answers carries what
 * the middleware put on the context — the session middleware's clear of a
 * stale cookie among it — and a `Set-Cookie` the handler returns rides only a
 * success whose writes committed.
 *
 * - `route_ok(value, {set_cookie?})` — `value` as JSON at 200, the
 *   `Set-Cookie` lines after any the middleware put on the context
 * - `route_fail(def, fields?)` — the definition's body at its status, with
 *   the headers it derives (`Retry-After`); never a cookie
 * - `route_raw({status, headers?, body?})` — a status, headers, and a body
 *   written as given: an empty body, bytes, a stream, a JSON-RPC envelope
 * - `route_sse(stream)` — the stream the route opened for this request
 *   (`RouteContext.open_sse`)
 *
 * A result is plain data, so domain code and shared helpers fail without the
 * Hono context (`return route_fail(REST_ROW_NOT_FOUND)`), and a handler
 * forwards a failure it was handed (`if (!result.ok) return result`).
 *
 * Hono-free: nothing here imports `hono`.
 *
 * @module
 */

import type { SchemaEntries, SchemaObjectInput } from '@fuzdev/fuz_schema/schema.ts';

import type { RestErrorDef } from './error_schemas.ts';
import type { SseStream } from '../realtime/sse.ts';

/** Options for `route_ok`. */
export interface RouteOkOptions {
	/**
	 * `Set-Cookie` header values, written in order after every `Set-Cookie`
	 * line the middleware put on the context — the session middleware's clear
	 * of a stale cookie first. Formatted by the caller
	 * (`session_cookie_header`, `clear_session_cookie_header`); the framework
	 * treats them as opaque lines.
	 */
	readonly set_cookie?: ReadonlyArray<string>;
}

/**
 * A success: `value` is the response body, answered as JSON at 200, with
 * `set_cookie`'s lines (`[]` for none).
 */
export interface RouteOk<T> {
	readonly ok: true;
	readonly value: T;
	readonly set_cookie: ReadonlyArray<string>;
}

/**
 * A failure, typed by what reaches the wire — its status, its code, and its
 * body — so a handler may answer with any definition whose body one of the
 * route's allowed definitions at that status and code accepts. `def` carries
 * the definition's `headers`.
 */
export interface RouteFail<TStatus extends number, TCode extends string, TBody> {
	readonly ok: false;
	readonly status: TStatus;
	readonly code: TCode;
	readonly body: TBody;
	/** The definition the failure was made from, at the same status and code. */
	readonly def: RestErrorDef<TStatus, TCode>;
}

/** A raw answer's body, written as given: none, text, bytes, or a byte stream. */
export type RouteRawBody = null | string | Uint8Array | ReadableStream<Uint8Array>;

/** A raw answer's headers by name; a name a response repeats takes a list. */
export type RouteRawHeaders = Readonly<Record<string, string | ReadonlyArray<string>>>;

/** What `route_raw` takes. */
export interface RouteRawInit {
	/** The status, 200 to 599. */
	readonly status: number;
	/** The headers, none of `ROUTE_RAW_REFUSED_HEADERS`; a body needs its `Content-Type`. */
	readonly headers?: RouteRawHeaders;
	/** The body, `null` (the default) for none. */
	readonly body?: RouteRawBody;
}

/** A raw answer (`route_raw`): a status, headers, and a body, written as given. */
export interface RouteRaw {
	readonly ok: 'raw';
	readonly status: number;
	readonly headers: RouteRawHeaders;
	readonly body: RouteRawBody;
}

/**
 * An SSE answer (`route_sse`): the stream `RouteContext.open_sse` opened for
 * this request, whose response the framework answers with.
 */
export interface RouteSse {
	readonly ok: 'sse';
	/** Typed to admit a stream of any event type — `SseStream` is contravariant in it. */
	readonly stream: SseStream<never>;
}

/**
 * The header names a raw answer may not carry, lowercase (compared
 * case-insensitively): `Set-Cookie`, which only a success carries
 * (`RouteOkOptions.set_cookie`), and the hop-by-hop names, which are the
 * server's to write — framing, the connection, an upgrade.
 */
export const ROUTE_RAW_REFUSED_HEADERS: ReadonlyArray<string> = Object.freeze([
	'set-cookie',
	'connection',
	'keep-alive',
	'proxy-connection',
	'transfer-encoding',
	'te',
	'trailer',
	'upgrade'
]);

/**
 * A JSON value's type made readonly at every depth: what a handler's
 * `route_ok` value is checked against. `route_ok` infers its value as written
 * (`{ready: true}`, not `{ready: boolean}`), arrays as readonly tuples, which
 * a readonly array of the output's element type accepts. A tuple reads as an
 * array of its elements. An index signature of `unknown` (a `loose_object`'s
 * other keys, a `record(unknown)`) is left out, so a value typed by an
 * interface, which has no index signature, is accepted.
 */
export type ReadonlyJson<T> = unknown extends T
	? T
	: T extends string | number | boolean | bigint | symbol | null | undefined
		? T
		: T extends ReadonlyArray<infer TItem>
			? ReadonlyArray<ReadonlyJson<TItem>>
			: {
					readonly [
						K in keyof T as string extends K ? (unknown extends T[K] ? never : K) : K
					]: ReadonlyJson<T[K]>;
				};

/** Any result a route handler returns. */
export type RouteResult =
	RouteOk<unknown> | RouteFail<number, string, unknown> | RouteRaw | RouteSse;

/** The input side of a definition's body: what `route_fail` builds from it. */
export type RestErrorBodyInput<TDef extends RestErrorDef> =
	TDef extends RestErrorDef<number, infer TCode, infer TFields>
		? { error: TCode } & SchemaObjectInput<TFields>
		: never;

/** A definition's failure result. Distributes over a union of definitions. */
export type RouteFailOf<TDef extends RestErrorDef> = TDef extends RestErrorDef
	? RouteFail<TDef['status'], TDef['code'], RestErrorBodyInput<TDef>>
	: never;

/**
 * The arguments `route_fail` takes after a definition: none for a bare code,
 * optional fields when every field is optional, required fields when any is.
 */
export type RouteFailFields<TDef extends RestErrorDef> =
	TDef extends RestErrorDef<number, string, infer TFields extends SchemaEntries>
		? keyof TFields extends never
			? []
			: // every field optional: the empty object is a body's fields
				// eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type
				Record<never, never> extends SchemaObjectInput<TFields>
				? [fields?: SchemaObjectInput<TFields>]
				: [fields: SchemaObjectInput<TFields>]
		: never;

/**
 * A success: the route answers `value` as JSON at 200, with the `Set-Cookie`
 * lines of `options.set_cookie` after any the middleware wrote.
 *
 * Typed in a handler by the input side of the route's `output` schema
 * (`ReadonlyJson`). The value is inferred as written, its literals kept.
 *
 * @param value - the response body, never `undefined`
 * @param options - the `Set-Cookie` lines the success carries
 */
export const route_ok = <
	// `{} | null` is every value but `undefined`, which is no JSON body
	// eslint-disable-next-line @typescript-eslint/no-empty-object-type
	const T extends {} | null
>(
	value: T,
	options?: RouteOkOptions
): RouteOk<T> => ({ ok: true, value, set_cookie: options?.set_cookie ?? [] });

/**
 * A failure: the route answers `{error: def.code, ...fields}` at `def.status`,
 * with the headers `def` derives from that body.
 *
 * In a handler it must be one the route allows: a definition in its `errors`,
 * one its `auth` or `rate_limit` derives, or a catch layer's answer
 * (`ALWAYS_ACCEPTED_ERRORS`) — or any definition whose body one of those
 * accepts at the same status and code.
 *
 * @param def - the definition, a `rest_error`
 * @param fields - the body's fields beside `error`: absent for a bare code, optional when every field is
 */
export const route_fail = <TDef extends RestErrorDef>(
	def: TDef,
	...fields: RouteFailFields<TDef>
): RouteFailOf<TDef> =>
	({
		ok: false,
		status: def.status,
		code: def.code,
		body: { error: def.code, ...(fields[0] as object | undefined) },
		def
	}) as unknown as RouteFailOf<TDef>;

/**
 * A raw answer at any status, described as data: an empty body, bytes, a
 * stream, a JSON-RPC envelope. A JSON answer of the route's own goes through
 * `route_ok` or `route_fail`.
 *
 * The framework checks it when it prepares the response, inside the route's
 * transaction, so a raw answer it refuses throws and rolls back:
 *
 * - a status outside 200 to 599
 * - a header of `ROUTE_RAW_REFUSED_HEADERS`, a name or value a `Headers`
 *   refuses, an empty value or an empty list (a runtime writes one its own
 *   way), one name twice in any case
 * - a non-null body without a `Content-Type` (a runtime would derive one,
 *   each its own way), and a body on a null-body status (204, 205, 304)
 * - a `Content-Length` that is not one run of ASCII digits, a list included,
 *   and one a text or bytes body doesn't have — the UTF-8 bytes of a string,
 *   the `byteLength` of a `Uint8Array`: a runtime either sends the wrong size
 *   or overrides it. With a null or stream body the size is the route's to
 *   declare: a `HEAD` or an `X-Accel-Redirect` answer sends one with no body
 * - a body that is none of `RouteRawBody` (a `Response` included), a stream
 *   that is locked, and bytes whose buffer is detached
 *
 * A stream that was read and released is unlocked yet can't be answered with,
 * and nothing shows it before a `Response` is built from it: that fails after
 * the commit, answering the error catch's 500 with an error naming the route
 * (or, on `@hono/node-server`, whose own `Response` reads the stream only as
 * it writes, an empty body). A stream body the route does not end up
 * answering with — refused here, or rolled back by a failed commit — is
 * cancelled, so its source is released.
 *
 * @param init - the status, headers, and body
 */
export const route_raw = (init: RouteRawInit): RouteRaw => ({
	ok: 'raw',
	status: init.status,
	headers: init.headers ?? {},
	body: init.body ?? null
});

/**
 * An SSE answer: the stream `RouteContext.open_sse` opened for this request.
 * The framework answers with that stream's response, and refuses (throws) a
 * stream this request did not open.
 *
 * @param stream - the stream, as `open_sse` returned it
 */
export const route_sse = (stream: SseStream<never>): RouteSse => ({ ok: 'sse', stream });
