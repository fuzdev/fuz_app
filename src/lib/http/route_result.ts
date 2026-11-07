/**
 * What a route handler returns: a success, a failure, or a response it built
 * itself. `apply_route_specs` turns the result into the `Response` — a success
 * is its JSON body at 200, a failure its definition's body at the definition's
 * status with the definition's headers (`Retry-After`), a raw result the
 * response as it is.
 *
 * A result is plain data, so domain code and shared helpers fail without the
 * Hono context (`return route_fail(REST_ROW_NOT_FOUND)`), and a handler
 * forwards a failure it was handed (`if (!result.ok) return result`). Headers
 * and cookies a handler sets on the context before it returns carry over onto
 * the response the framework builds.
 *
 * Hono-free: `hono` is imported for its types alone.
 *
 * @module
 */

import type { TypedResponse } from 'hono';
import type { StatusCode } from 'hono/utils/http-status';
import type { SchemaEntries, SchemaObjectInput } from '@fuzdev/fuz_schema/schema.ts';

import type { RestErrorDef } from './error_schemas.ts';

/** A success: `value` is the response body, answered as JSON at 200. */
export interface RouteOk<T> {
	readonly ok: true;
	readonly value: T;
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

/** A response the handler built itself, answered as it is (`route_raw`). */
export interface RouteRaw {
	readonly ok: 'raw';
	readonly response: Response;
}

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
export type RouteResult = RouteOk<unknown> | RouteFail<number, string, unknown> | RouteRaw;

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
 * A success: the route answers `value` as JSON at 200.
 *
 * Typed in a handler by the input side of the route's `output` schema
 * (`ReadonlyJson`). The value is inferred as written, its literals kept.
 *
 * @param value - the response body, never `undefined`
 */
// `{} | null` is every value but `undefined`, which is no JSON body
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export const route_ok = <const T extends {} | null>(value: T): RouteOk<T> => ({ ok: true, value });

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
 * A response the handler built itself, at any status: an empty body, bytes, a
 * stream, a JSON-RPC envelope. A JSON answer of the route's own goes through
 * `route_ok` or `route_fail`, so a `Response` typed as Hono's `c.json` return
 * is refused.
 *
 * @param response - the response, answered as it is
 */
export const route_raw = <TResponse extends Response>(
	response: TResponse &
		(TResponse extends TypedResponse<unknown, StatusCode, 'json'> ? never : unknown)
): RouteRaw => ({ ok: 'raw', response });
