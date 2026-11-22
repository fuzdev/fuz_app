/**
 * Normalizing and diffing two backends' transcripts of one test, for the
 * transcript differential (`transcript_differential.ts`).
 *
 * The whole transcript goes through the conformance differential's
 * normalizer (`normalize_differential_response`) as one synthetic body, so a
 * placeholder is stable across requests: an id one response mints and a
 * later request echoes keeps one `<uuid:n>`, numbered from where it first
 * appears — what the fixture helpers send included (`create_account`, the
 * dead-credential mints). Ahead of it, pre-passes rewrite what that
 * normalizer would number or leave raw but which, across one transcript
 * rather than one response, varies per backend run:
 *
 * - **timestamps** — every `ISO8601_SECONDS` match becomes its offset from
 *   the transcript's anchor, the earliest timestamp any response carries,
 *   rounded to the minute (`<t+10080m>` for an expiry a week out). The two
 *   sides run at different wall times, so absolute values never match, but a
 *   deadline set a day or an hour off on one side moves its offset. Minutes
 *   are far coarser than the spread of one test's own timestamps (seconds at
 *   most, both spines reading one clock) and still see any shift of half a
 *   minute or more; anchoring on the earliest rather than the first seen
 *   keeps the anchor independent of key order, which differs between spines.
 * - **audit `seq`** — an audit row's `seq` (an object carrying `seq` and
 *   `event_type`) becomes a number, its distance from the smallest `seq` the
 *   transcript holds, so gaps and order are compared and a `seq` that is not
 *   a number stays raw and differs. The smallest `seq` itself is returned as
 *   `seq_base`: it counts every audit row the backend wrote earlier in the
 *   run (the per-test reset deletes rows without restarting the sequence), so
 *   the registration compares its step from the previous test's — the rows
 *   written between the two — while neither side has failed a test.
 * - **a token's touch, read by its own request** — in the answer to a request
 *   carrying an API token, that token's row (`id` the request's
 *   `bearer_token_id`) has its `last_used_at` and `last_used_ip` read as
 *   `OWN_TOUCH`. The bearer leg's touch runs concurrently with the request it
 *   authenticates, on both spines, so whether that request's own read sees
 *   it is promised by neither; a later request reads it settled, since both
 *   test binaries settle an answer's writes before answering, and compares.
 * - **uppercase UUIDs in requests** — a suite sending `id.toUpperCase()`
 *   sends a value the normalizer doesn't recognize; it becomes `upper:` plus
 *   the lowercase form, which then shares the id's placeholder. Responses are
 *   left alone: an uppercase UUID in an answer is a wire difference.
 *
 * Request headers are compared by name. Response headers are compared by
 * name, and by value for `COMPARED_HEADER_VALUES`; a header compared by name
 * only reads `true`. Of `Set-Cookie`, each entry keeps the session cookie's
 * classified effect, its lines with the cookie value masked (so `Max-Age`
 * and every attribute are compared byte for byte), and the sorted names of
 * every cookie the response sets.
 *
 * @module
 */

import {
	diff_differential_responses,
	normalize_differential_response,
	VOLATILE_HEADER_NAMES,
	type DifferentialDiff
} from '#lib/testing/cross_backend/differential_normalize.ts';
import {
	classify_session_cookie_effect,
	filter_session_set_cookies
} from '#lib/testing/cross_backend/session_cookie_effect.ts';

import type { TranscriptEntry } from './transcript_record.ts';

/**
 * Response headers whose values are compared, not just their presence: ones
 * a route sets as a contract and no server writes per request. `set-cookie`
 * is compared through its own fields, and `retry-after` counts down, so
 * neither is here.
 */
export const COMPARED_HEADER_VALUES: ReadonlyArray<string> = [
	'cache-control',
	'content-type',
	'vary'
];

const TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g;
const UPPER_UUID_PATTERN =
	/(?<![0-9A-Za-z])(?=[0-9A-F-]*[A-F])[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}(?![0-9A-Za-z])/g;

/**
 * Rebuild `value` depth first, `on_string` applied to every string (keys
 * included) and `on_object`, when given, to every object after its members.
 */
const map_value = (
	value: unknown,
	on_string: (s: string) => string,
	on_object?: (o: Record<string, unknown>) => Record<string, unknown>
): unknown => {
	if (typeof value === 'string') return on_string(value);
	if (Array.isArray(value)) return value.map((v) => map_value(v, on_string, on_object));
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[on_string(k)] = map_value(v, on_string, on_object);
		}
		return on_object ? on_object(out) : out;
	}
	return value;
};

/** Every string and object in `value`, visited without rebuilding it. */
const visit_value = (
	value: unknown,
	on_string: (s: string) => void,
	on_object: (o: Record<string, unknown>) => void
): void => {
	map_value(
		value,
		(s) => {
			on_string(s);
			return s;
		},
		(o) => {
			on_object(o);
			return o;
		}
	);
};

const is_audit_row = (o: Record<string, unknown>): boolean => 'seq' in o && 'event_type' in o;

/** What a token row's touch fields read as in the answer to the request the token authenticates. */
export const OWN_TOUCH = '<own_touch>';

/** The touch fields a token row carries. */
const TOKEN_TOUCH_FIELDS = ['last_used_at', 'last_used_ip'] as const;

/**
 * `o` with its touch fields read as `OWN_TOUCH` when it is the row of the
 * token `token_id` — any touch the row holds, settled or not: the touch of
 * the request itself races its answer on both spines, and the database diff
 * compares the settled touch.
 */
const erase_own_touch = (
	o: Record<string, unknown>,
	token_id: string | undefined
): Record<string, unknown> => {
	if (token_id === undefined || o.id !== token_id || !('last_used_at' in o)) return o;
	const out = { ...o };
	for (const field of TOKEN_TOUCH_FIELDS) if (field in out) out[field] = OWN_TOUCH;
	return out;
};

const lower_request_uuids = (s: string): string =>
	s.replace(UPPER_UUID_PATTERN, (m) => `upper:${m.toLowerCase()}`);

const MS_PER_MINUTE = 60_000;

/** `<t+Nm>`: `ms` from the anchor, to the nearest minute. */
const format_offset = (ms: number): string => {
	const minutes = Math.round(ms / MS_PER_MINUTE) || 0; // no `-0`
	return `<t${minutes < 0 ? '-' : '+'}${Math.abs(minutes)}m>`;
};

/** The set-cookie line's name, the text before its first `=`. */
const cookie_name_of = (line: string): string => {
	const eq = line.indexOf('=');
	return eq === -1 ? line.trim() : line.slice(0, eq).trim();
};

/** The line with the cookie's value masked; an empty value (a clear) stays empty. */
const mask_cookie_value = (line: string): string =>
	line.replace(/^([^=]*=)([^;]*)/, (_m, name: string, value: string) =>
		value === '' ? name : `${name}<value>`
	);

const to_request_headers = (names: ReadonlyArray<string>): Record<string, true> => {
	const out: Record<string, true> = {};
	for (const name of names) {
		if (!VOLATILE_HEADER_NAMES.includes(name)) out[name] = true;
	}
	return out;
};

const to_response_headers = (
	headers: Readonly<Record<string, string>>
): Record<string, string | true> => {
	const out: Record<string, string | true> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (VOLATILE_HEADER_NAMES.includes(name)) continue;
		out[name] = COMPARED_HEADER_VALUES.includes(name) ? value : true;
	}
	return out;
};

/** Where the smallest audit `seq` of a transcript sits, and its value. */
export interface TranscriptSeqBase {
	/** The first entry whose response holds it. */
	readonly index: number;
	readonly value: number;
}

/** One backend's transcript of a test, normalized. */
export interface NormalizedTranscript {
	readonly entries: Array<Record<string, unknown>>;
	/** The smallest audit `seq` the responses hold, `null` with none. */
	readonly seq_base: TranscriptSeqBase | null;
}

/**
 * Normalize one backend's transcript of a test.
 *
 * @param entries - the recorded entries
 * @param cookie_name - the session cookie's name, which each entry's `session_cookie` classifies
 * @returns one normalized entry per recorded one, in order, and the transcript's `seq` base
 */
export const normalize_transcript = (
	entries: ReadonlyArray<TranscriptEntry>,
	cookie_name: string
): NormalizedTranscript => {
	// the anchors: the earliest response timestamp, the smallest audit `seq`
	const anchors: { ms: number | null; seq: TranscriptSeqBase | null } = { ms: null, seq: null };
	entries.forEach((e, index) => {
		if (!e.response) return;
		visit_value(
			e.response.body,
			(s) => {
				for (const m of s.matchAll(TIMESTAMP_PATTERN)) {
					const ms = Date.parse(m[0]);
					if (anchors.ms === null || ms < anchors.ms) anchors.ms = ms;
				}
			},
			(o) => {
				if (!is_audit_row(o) || typeof o.seq !== 'number') return;
				if (anchors.seq === null || o.seq < anchors.seq.value) {
					anchors.seq = { index, value: o.seq };
				}
			}
		);
	});
	const { ms: anchor_ms, seq: seq_base } = anchors;
	const on_response_string = (s: string): string =>
		s.replace(TIMESTAMP_PATTERN, (m) =>
			anchor_ms === null ? '<t>' : format_offset(Date.parse(m) - anchor_ms)
		);
	const on_request_string = (s: string): string => lower_request_uuids(on_response_string(s));
	const relative_seq = (o: Record<string, unknown>): Record<string, unknown> =>
		is_audit_row(o) && typeof o.seq === 'number' && seq_base !== null
			? { ...o, seq: o.seq - seq_base.value }
			: o;
	const shaped = entries.map((e) => ({
		request: {
			...(e.request.via && { via: e.request.via }),
			method: e.request.method,
			path: on_request_string(e.request.path),
			headers: to_request_headers(e.request.header_names),
			body: map_value(e.request.body, on_request_string)
		},
		response: e.response && {
			status: e.response.status,
			headers: to_response_headers(e.response.headers),
			session_cookie:
				classify_session_cookie_effect(e.response.set_cookies, cookie_name) ?? 'unrecognized',
			session_cookie_lines: filter_session_set_cookies(e.response.set_cookies, cookie_name).map(
				mask_cookie_value
			),
			set_cookie_names: e.response.set_cookies.map(cookie_name_of).sort(),
			body: map_value(e.response.body, on_response_string, (o) =>
				relative_seq(erase_own_touch(o, e.request.bearer_token_id))
			)
		}
	}));
	const normalized = normalize_differential_response(
		{ status: 0, headers: {}, set_cookies: [], body: shaped },
		cookie_name
	);
	return { entries: normalized.body as Array<Record<string, unknown>>, seq_base };
};

/** Where two transcripts stop lining up: the first entry whose route differs. */
export interface TranscriptMisalignment {
	readonly index: number;
	readonly a: Record<string, unknown> | undefined;
	readonly b: Record<string, unknown> | undefined;
}

/** One difference, `index` the entry and `path` relative to it (`response.body.error`). */
export interface TranscriptDiff extends DifferentialDiff {
	readonly index: number;
}

/** The JSON-RPC method a request body or `?method=` names, `''` for none. */
const rpc_method_of = (request: { path?: string; body?: unknown }): string => {
	const { body } = request;
	const of_envelope = (e: unknown): string | null =>
		e !== null && typeof e === 'object' && 'jsonrpc' in e && 'method' in e
			? String((e as { method: unknown }).method)
			: null;
	if (Array.isArray(body)) {
		const methods = body.map(of_envelope).filter((m) => m !== null);
		if (methods.length > 0) return `[${methods.join(',')}]`;
	} else {
		const method = of_envelope(body);
		if (method !== null) return method;
	}
	const query = request.path?.split('?')[1];
	return (query && new URLSearchParams(query).get('method')) ?? '';
};

/**
 * An entry's route: method, path without its query, and the JSON-RPC method
 * it calls, since every RPC call shares one path — an inserted call then
 * shows as a misalignment, not as a cascade of body differences.
 */
const route_of = (entry: Record<string, unknown> | undefined): string | undefined => {
	const request = entry?.request as { method?: string; path?: string; body?: unknown } | undefined;
	if (!request) return undefined;
	const rpc_method = rpc_method_of(request);
	return `${request.method} ${request.path?.split('?')[0]}${rpc_method && ` ${rpc_method}`}`;
};

/**
 * Diff two normalized transcripts entry by entry, up to the first entry whose
 * route doesn't line up; past it every entry would differ, so the cascade
 * isn't listed.
 *
 * @param a - one side's normalized entries
 * @param b - the other's
 * @returns the differences, and the misalignment when there is one
 */
export const diff_transcripts = (
	a: ReadonlyArray<Record<string, unknown>>,
	b: ReadonlyArray<Record<string, unknown>>
): { diffs: Array<TranscriptDiff>; misalignment: TranscriptMisalignment | null } => {
	const diffs: Array<TranscriptDiff> = [];
	const length = Math.max(a.length, b.length);
	for (let index = 0; index < length; index++) {
		if (route_of(a[index]) !== route_of(b[index])) {
			return { diffs, misalignment: { index, a: a[index], b: b[index] } };
		}
		const entry_diffs = diff_differential_responses(
			{ status: 0, header_names: [], session_cookie: 'none', body: a[index] },
			{ status: 0, header_names: [], session_cookie: 'none', body: b[index] }
		);
		for (const d of entry_diffs) {
			diffs.push({ index, path: d.path.replace(/^body\./, ''), a: d.a, b: d.b });
		}
	}
	return { diffs, misalignment: null };
};
