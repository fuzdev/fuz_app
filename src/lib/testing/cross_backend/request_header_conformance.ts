import '../assert_dev_env.ts';

/**
 * The request header conformance table: how both spines read `Origin`,
 * `Referer`, `Host` and `Content-Type` — the gates' inputs — and what a
 * request carrying given lines of them observably does.
 *
 * `request_header_conformance.json` (beside this module) holds one row per
 * case, `{name, lines, read, post?, upgrade?, upgrade_runtime_refusal?,
 * wire_reason?, note?}`:
 *
 * - **lines** — header lines, each `Name: value`, one byte per character (a
 *   character U+0080–U+00FF is that byte on the wire). A name may repeat.
 * - **read** — each reader's reading of exactly those lines
 *   (`http/request_headers.ts`, the Rust `fuz_http::request_headers`):
 *   `origin`, `host` and `content_type` are `"absent"`, `"refused"`, or
 *   `{"one": value}` (`HeaderRead`; a content type's value is its lowercased
 *   essence), and `browser_context` whether an `Origin` or `Referer` line is
 *   there at all.
 * - **post** and **upgrade** — what the request does on the wire, sent as an
 *   RPC `POST` and as a WebSocket upgrade: `{"refused": code}`, or
 *   `{"authenticates": credential}` (`null` for none). The wire leg adds a
 *   `Host` naming the server when the row has no `Host` line, and
 *   `Content-Type: application/json` on the `POST` when it has no
 *   `Content-Type` line, so a row says only what it is about. Where one
 *   request trips several gates the row pins which answers: the host gate,
 *   then the origin check, then the content type, then the credential legs.
 * - **upgrade_runtime_refusal** — a runtime trait the row's upgrade meets
 *   before the app runs on a backend declaring it
 *   (`BackendCapabilities.ws_upgrade_runtime_refusals`).
 * - **wire_reason** — present instead of `post` and `upgrade` on a row the
 *   wire leg can't send as the row means it; the unit legs still read it.
 *
 * The legs: the TS unit test over the readers (`src/test/http/`), the Rust
 * unit test beside `fuz_http::request_headers` over a byte-identical copy of
 * the file, and `request_header_conformance_wire.ts`, sending each row to a
 * live backend. Both unit legs also hold every row **join-invariant**: the
 * reading of its lines equals the reading of the same lines folded to one
 * line per name (`fold_header_lines`) — the view Bun and an in-process
 * `app.request` give the spine — which is what lets one expected column hold
 * on every runtime.
 *
 * Live values are per leg, so lines name them with `{placeholders}`
 * (`REQUEST_HEADER_CONFORMANCE_PLACEHOLDERS`); the unit legs fill them from
 * the table's own `unit_placeholders`. Edited by hand, never generated.
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import {
	array,
	boolean,
	literal,
	min_length,
	nullable,
	object,
	one_of,
	optional,
	parse_or_throw,
	pipe,
	string,
	union,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

import { BUILTIN_CREDENTIAL_TYPES } from '../../auth/credential_type_schema.ts';
import {
	ERROR_FORBIDDEN_HOST,
	ERROR_FORBIDDEN_ORIGIN,
	ERROR_UNSUPPORTED_CONTENT_TYPE
} from '../../http/error_schemas.ts';
import { trim_optional_whitespace } from '../../http/header_lines.ts';
import type { HeaderRead } from '../../http/request_headers.ts';
import { WS_UPGRADE_RUNTIME_REFUSALS } from './capabilities.ts';

/** One reader's reading in the table: `"absent"`, `"refused"`, or `{"one": value}`. */
export const RequestHeaderConformanceRead = union([
	literal('absent'),
	literal('refused'),
	object({ one: string })
]);
export type RequestHeaderConformanceRead = Infer<typeof RequestHeaderConformanceRead>;

/** What a request observably does — refused with a code, or authenticated as a credential. */
export const RequestHeaderConformanceOutcome = union([
	object({
		refused: one_of([ERROR_FORBIDDEN_HOST, ERROR_FORBIDDEN_ORIGIN, ERROR_UNSUPPORTED_CONTENT_TYPE])
	}),
	object({ authenticates: nullable(one_of(BUILTIN_CREDENTIAL_TYPES)) })
]);
export type RequestHeaderConformanceOutcome = Infer<typeof RequestHeaderConformanceOutcome>;

/** One row of the table. */
export const RequestHeaderConformanceRow = object({
	name: string,
	lines: array(string),
	read: object({
		origin: RequestHeaderConformanceRead,
		browser_context: boolean,
		host: RequestHeaderConformanceRead,
		content_type: RequestHeaderConformanceRead
	}),
	post: optional(RequestHeaderConformanceOutcome),
	upgrade: optional(RequestHeaderConformanceOutcome),
	upgrade_runtime_refusal: optional(one_of(WS_UPGRADE_RUNTIME_REFUSALS)),
	wire_reason: optional(string),
	note: optional(string)
});
export type RequestHeaderConformanceRow = Infer<typeof RequestHeaderConformanceRow>;

/** The placeholder names a row may use, each written `{name}` in the table. */
export const REQUEST_HEADER_CONFORMANCE_PLACEHOLDERS = [
	'cookie_name',
	'session_cookie',
	'api_token',
	'daemon_token',
	'host',
	'foreign_host',
	'origin',
	'foreign_origin'
] as const;

/** A placeholder name — see `REQUEST_HEADER_CONFORMANCE_PLACEHOLDERS`. */
export type RequestHeaderConformancePlaceholder =
	(typeof REQUEST_HEADER_CONFORMANCE_PLACEHOLDERS)[number];

/** The value each placeholder takes on one leg. */
export type RequestHeaderConformancePlaceholders = Readonly<
	Record<RequestHeaderConformancePlaceholder, string>
>;

/** The table, a `@fuzdev/fuz_schema` `object`. */
export const RequestHeaderConformance = object({
	unit_placeholders: object({
		cookie_name: string,
		session_cookie: string,
		api_token: string,
		daemon_token: string,
		host: string,
		foreign_host: string,
		origin: string,
		foreign_origin: string
	}),
	rows: pipe(array(RequestHeaderConformanceRow), min_length(1))
});
export type RequestHeaderConformance = Infer<typeof RequestHeaderConformance>;

/** The committed table, resolved relative to this module. */
export const REQUEST_HEADER_CONFORMANCE_URL: URL = new URL(
	'./request_header_conformance.json',
	import.meta.url
);

/**
 * Read and parse the committed table, and check each row is either a wire
 * row (`post` and `upgrade`) or names why it isn't (`wire_reason`).
 *
 * @throws Error when the file is off the schema, or a row is neither
 */
export const load_request_header_conformance = (): RequestHeaderConformance => {
	const table = parse_or_throw(
		RequestHeaderConformance,
		JSON.parse(readFileSync(REQUEST_HEADER_CONFORMANCE_URL, 'utf8'))
	);
	for (const row of table.rows) {
		const wire = row.post !== undefined && row.upgrade !== undefined;
		const unit_only =
			row.wire_reason !== undefined && row.post === undefined && row.upgrade === undefined;
		if (wire === unit_only) {
			throw new Error(
				`request header conformance row '${row.name}': give both \`post\` and \`upgrade\`, or a \`wire_reason\` and neither`
			);
		}
		if (row.upgrade_runtime_refusal !== undefined && !wire) {
			throw new Error(
				`request header conformance row '${row.name}': \`upgrade_runtime_refusal\` on a row the wire leg doesn't send`
			);
		}
	}
	return table;
};

const PLACEHOLDER_REGEX = /\{([a-z_]+)\}/g;

/**
 * Fill a row's `{placeholders}`.
 *
 * @throws Error on a placeholder this leg has no value for
 */
export const fill_request_header_conformance_placeholders = (
	text: string,
	placeholders: RequestHeaderConformancePlaceholders
): string =>
	text.replace(PLACEHOLDER_REGEX, (_match, name: string) => {
		if (!Object.hasOwn(placeholders, name)) {
			throw new Error(`unknown request header conformance placeholder {${name}}`);
		}
		return placeholders[name as RequestHeaderConformancePlaceholder];
	});

/** A reading in the table's spelling, its `one` value filled. */
export const fill_request_header_conformance_read = (
	read: RequestHeaderConformanceRead,
	placeholders: RequestHeaderConformancePlaceholders
): RequestHeaderConformanceRead =>
	typeof read === 'string'
		? read
		: { one: fill_request_header_conformance_placeholders(read.one, placeholders) };

/** A reader's `HeaderRead` in the table's spelling. */
export const to_request_header_conformance_read = (
	read: HeaderRead<string>
): RequestHeaderConformanceRead => (read.kind === 'one' ? { one: read.value } : read.kind);

/** One header line, split at its first `:` and its value stripped of SP and HTAB, as a request-head parser reads it. */
export interface ParsedHeaderLine {
	/** The name as written. */
	readonly name: string;
	/** The value, outer SP and HTAB stripped. */
	readonly value: string;
}

/**
 * Split a `Name: value` line.
 *
 * @throws Error on a line with no `:` — the table holds none
 */
export const parse_request_header_line = (line: string): ParsedHeaderLine => {
	const colon = line.indexOf(':');
	if (colon <= 0) throw new Error(`not a header line: ${JSON.stringify(line)}`);
	return {
		name: line.slice(0, colon),
		value: trim_optional_whitespace(line.slice(colon + 1))
	};
};

/**
 * The values of one header among `lines`, in order — what `get_header_lines`
 * answers on a runtime with a per-line view.
 *
 * @param lines - `Name: value` lines
 * @param name - the header name, in any case
 */
export const request_header_values = (
	lines: ReadonlyArray<string>,
	name: string
): Array<string> => {
	const lower = name.toLowerCase();
	return lines
		.map(parse_request_header_line)
		.filter((line) => line.name.toLowerCase() === lower)
		.map((line) => line.value);
};

/**
 * Fold `lines` to one line per name, in the order each name first appears —
 * the view a runtime without a per-line view gives: the Fetch `Headers` value,
 * its lines joined with `, ` (`; ` for `Cookie`), then stripped of SP and HTAB
 * at both ends as `get_header_lines` strips every line.
 *
 * @param lines - `Name: value` lines
 * @returns one `Name: value` line per name
 */
export const fold_header_lines = (lines: ReadonlyArray<string>): Array<string> => {
	const folded: Map<string, { name: string; values: Array<string> }> = new Map();
	for (const line of lines.map(parse_request_header_line)) {
		const key = line.name.toLowerCase();
		const entry = folded.get(key);
		if (entry) entry.values.push(line.value);
		else folded.set(key, { name: line.name, values: [line.value] });
	}
	return [...folded.entries()].map(
		([key, { name, values }]) =>
			`${name}: ${trim_optional_whitespace(values.join(key === 'cookie' ? '; ' : ', '))}`
	);
};
