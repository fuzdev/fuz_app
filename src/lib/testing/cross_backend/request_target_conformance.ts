import '../assert_dev_env.ts';

/**
 * The request target conformance table: how both spines decode what a matched
 * route reads of the request target — the query string and the path params —
 * and what a request carrying a given target observably answers.
 *
 * `request_target_conformance.json` (beside this module) has three sections:
 *
 * - **query** — `{name, query, read}`: the raw query string (the text after
 *   `?`, or `null` for a target with none) and what the strict query reader
 *   (`http/request_target.ts`, the Rust `fuz_http::request_target`) reads of
 *   it — `{"pairs": [[name, value], …]}`, every pair in order, or
 *   `{"refused": reason}` (`PercentDecodeError`).
 * - **param** — `{name, segment, read}`: one raw path segment and what the
 *   strict segment reader reads of it — `{"value": text}` or
 *   `{"refused": reason}`.
 * - **wire** — `{name, method, target, as, upgrade?, requires?, expect, note?}`:
 *   a request sent over a raw socket with its target written as is, by the
 *   principal `as` names (`"keeper_session"` or `"none"`), as a WebSocket
 *   upgrade when `upgrade` is set, and only to a backend declaring the
 *   capability `requires` names. `expect` pins the answer's `status`, the
 *   REST `error` code, and on a JSON-RPC answer the envelope's `id` — which
 *   pins the decoding of an echoed value — with its error `code` and
 *   `data.reason`. Never a whole body, and never the DEV-only `issues`.
 *
 * Wire targets name the backend's paths with `{placeholders}`
 * (`REQUEST_TARGET_CONFORMANCE_PLACEHOLDERS`), filled per backend.
 *
 * The legs: the TS unit test over the readers (`src/test/http/`), the Rust
 * unit test beside `fuz_http::request_target` over a byte-identical copy of
 * the file, and `request_target_conformance_wire.ts`, sending each wire row to
 * a live backend. Edited by hand, never generated.
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import {
	array,
	boolean,
	integer,
	literal,
	max_length,
	min_length,
	nullable,
	number,
	object,
	one_of,
	optional,
	parse_or_throw,
	pipe,
	string,
	union,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

import { PERCENT_DECODE_ERRORS } from '../../http/request_target.ts';

/** A refusal in the table: the reader's `PercentDecodeError`. */
export const RequestTargetConformanceRefused = object({ refused: one_of(PERCENT_DECODE_ERRORS) });
export type RequestTargetConformanceRefused = Infer<typeof RequestTargetConformanceRefused>;

/** One row of the `query` section. */
export const RequestTargetConformanceQueryRow = object({
	name: string,
	query: nullable(string),
	read: union([
		object({ pairs: array(pipe(array(string), min_length(2), max_length(2))) }),
		RequestTargetConformanceRefused
	])
});
export type RequestTargetConformanceQueryRow = Infer<typeof RequestTargetConformanceQueryRow>;

/** One row of the `param` section. */
export const RequestTargetConformanceParamRow = object({
	name: string,
	segment: string,
	read: union([object({ value: string }), RequestTargetConformanceRefused])
});
export type RequestTargetConformanceParamRow = Infer<typeof RequestTargetConformanceParamRow>;

/** Who sends a wire row: the keeper's session cookie, or no credential. */
export const REQUEST_TARGET_CONFORMANCE_PRINCIPALS = ['keeper_session', 'none'] as const;

/** The backend capabilities a wire row may require. */
export const REQUEST_TARGET_CONFORMANCE_REQUIREMENTS = [
	'ws',
	'account_status',
	'fact_serving',
	'fact_serving_admin_hash'
] as const;

/** What a wire row's answer must carry. */
export const RequestTargetConformanceExpect = object({
	status: pipe(number, integer),
	/** The REST error body's `error` code. */
	error: optional(string),
	/** The JSON-RPC envelope: its `id`, and on an error its `code` and `data.reason`. */
	jsonrpc: optional(
		object({
			id: union([string, number, literal(null)]),
			code: optional(pipe(number, integer)),
			reason: optional(string)
		})
	)
});
export type RequestTargetConformanceExpect = Infer<typeof RequestTargetConformanceExpect>;

/** One row of the `wire` section. */
export const RequestTargetConformanceWireRow = object({
	name: string,
	method: string,
	target: string,
	as: one_of(REQUEST_TARGET_CONFORMANCE_PRINCIPALS),
	upgrade: optional(boolean),
	requires: optional(one_of(REQUEST_TARGET_CONFORMANCE_REQUIREMENTS)),
	expect: RequestTargetConformanceExpect,
	note: optional(string)
});
export type RequestTargetConformanceWireRow = Infer<typeof RequestTargetConformanceWireRow>;

/** The table, a `@fuzdev/fuz_schema` `object`. */
export const RequestTargetConformance = object({
	query: pipe(array(RequestTargetConformanceQueryRow), min_length(1)),
	param: pipe(array(RequestTargetConformanceParamRow), min_length(1)),
	wire: pipe(array(RequestTargetConformanceWireRow), min_length(1))
});
export type RequestTargetConformance = Infer<typeof RequestTargetConformance>;

/** The placeholder names a wire target may use, each written `{name}` in the table. */
export const REQUEST_TARGET_CONFORMANCE_PLACEHOLDERS = [
	'rpc_path',
	'ws_path',
	'account_status_path'
] as const;

/** A placeholder name — see `REQUEST_TARGET_CONFORMANCE_PLACEHOLDERS`. */
export type RequestTargetConformancePlaceholder =
	(typeof REQUEST_TARGET_CONFORMANCE_PLACEHOLDERS)[number];

/** The value each placeholder takes on one backend. */
export type RequestTargetConformancePlaceholders = Readonly<
	Record<RequestTargetConformancePlaceholder, string>
>;

/** The committed table, resolved relative to this module. */
export const REQUEST_TARGET_CONFORMANCE_URL: URL = new URL(
	'./request_target_conformance.json',
	import.meta.url
);

/**
 * Read and parse the committed table, and check every row name is unique
 * within its section.
 *
 * @throws Error when the file is off the schema, or a section repeats a name
 */
export const load_request_target_conformance = (): RequestTargetConformance => {
	const table = parse_or_throw(
		RequestTargetConformance,
		JSON.parse(readFileSync(REQUEST_TARGET_CONFORMANCE_URL, 'utf8'))
	);
	for (const [section, rows] of Object.entries(table)) {
		const names = new Set<string>();
		for (const row of rows as ReadonlyArray<{ name: string }>) {
			if (names.has(row.name)) {
				throw new Error(`request target conformance: '${row.name}' twice in \`${section}\``);
			}
			names.add(row.name);
		}
	}
	return table;
};

const PLACEHOLDER_REGEX = /\{([a-z_]+)\}/g;

/**
 * Fill a wire target's `{placeholders}`.
 *
 * @throws Error on a placeholder this backend has no value for
 */
export const fill_request_target_conformance_placeholders = (
	target: string,
	placeholders: RequestTargetConformancePlaceholders
): string =>
	target.replace(PLACEHOLDER_REGEX, (_match, name: string) => {
		if (!Object.hasOwn(placeholders, name)) {
			throw new Error(`unknown request target conformance placeholder {${name}}`);
		}
		return placeholders[name as RequestTargetConformancePlaceholder];
	});
