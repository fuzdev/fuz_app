import '../assert_dev_env.ts';

/**
 * Response normalization for the cross-backend differential.
 *
 * The differential (`describe_differential_conformance_tests`) sends one
 * conformance case to two backends, each over its own database with its own
 * keeper, so every id, timestamp and token differs between the two answers
 * even when the backends agree. `normalize_differential_response` maps a
 * response onto a canonical `{status, body, header_names}` that keeps what a
 * client can rely on and drops what is fresh per run:
 *
 * - **Positional placeholders.** Each volatile value is replaced by its kind
 *   and the order it was first seen in that response: the first UUID becomes
 *   `<uuid:1>`, the next distinct one `<uuid:2>`, and a repeat of the first is
 *   `<uuid:1>` again. So identity relations within one response survive (the
 *   `account_id` of a listed row equals the caller's), while the values
 *   themselves may differ across backends. The kinds, each matched anywhere
 *   inside a string, are `VOLATILE_VALUE_PATTERNS`: API tokens, API token
 *   ids (`tok_…`), lowercase UUIDs, second-precision UTC timestamps
 *   (`ISO8601_SECONDS`, the canonical wire shape) and bare 64-character
 *   lowercase hex digests (random session ids). Only the canonical spelling
 *   of each is placeholdered — an uppercase UUID or a millisecond timestamp
 *   stays raw and shows up as a difference, since a format divergence is a
 *   wire divergence.
 * - **Content addresses are compared verbatim.** A `blake3:`-prefixed hash
 *   names bytes, and equal bytes hash equal on both spines, so it is left as
 *   is: a differing fact hash is a real divergence. A fact whose bytes embed a
 *   volatile value differs by design, which is a ledger row's job.
 * - **Object key order doesn't matter.** Keys are sorted, and the walk that
 *   numbers placeholders visits them in that order, so two bodies whose keys
 *   differ only in order normalize the same.
 * - **Array order does.** Arrays keep their order — a list's order is part of
 *   its contract.
 * - **Header names, not values.** `header_names` is the sorted set of response
 *   header names minus `VOLATILE_HEADER_NAMES`: framing and per-request
 *   headers (`date`, `content-length`, `transfer-encoding`, `connection`,
 *   `keep-alive`) that each HTTP server sets its own way. Values are not
 *   compared at all — `set-cookie` carries a fresh credential on every login,
 *   and the header values that are contracts are pinned per backend by the
 *   conformance table's `expect.headers` and its no-fingerprint floor. A
 *   header one backend sends and the other doesn't is still a difference.
 *
 * `diff_differential_responses` lists every place two normalized responses
 * differ, one entry per leaf path, which is what a known-divergence ledger
 * entry names.
 *
 * Placeholders are positional, not tied to fixture identity: they keep which
 * values repeat within a response, not which fixture entity each one is, so
 * two ids that appear once each and trade places normalize equal.
 *
 * Placeholder numbering is per response and per kind. Object keys are
 * normalized too, but sorted by their raw text, so a record keyed by ids would
 * order its entries by values that differ across backends — no conformance
 * response is shaped that way today.
 *
 * @module
 */

/**
 * The canonical form of one response: what the differential compares across
 * backends.
 */
export interface DifferentialResponse {
	/** HTTP status. */
	readonly status: number;
	/** The JSON body with volatile values placeholdered and keys sorted. */
	readonly body: unknown;
	/** Sorted response header names, minus `VOLATILE_HEADER_NAMES`. */
	readonly header_names: ReadonlyArray<string>;
}

/** The raw response `normalize_differential_response` takes. */
export interface DifferentialRawResponse {
	readonly status: number;
	/** Header snapshot with lowercased names (`headers_to_record`'s shape). */
	readonly headers: Readonly<Record<string, string>>;
	readonly body: unknown;
}

/**
 * Response headers left out of `header_names`: framing and per-request
 * headers each HTTP server sets its own way, which say nothing about the
 * application. Lowercased.
 */
export const VOLATILE_HEADER_NAMES: ReadonlyArray<string> = [
	'connection',
	'content-length',
	'date',
	'keep-alive',
	'transfer-encoding'
];

/** One kind of volatile value: its placeholder name and what matches it. */
export interface VolatileValuePattern {
	/** The placeholder's kind, as in `<uuid:1>`. */
	readonly kind: string;
	/** Matches every occurrence inside a string; must carry the `g` flag. */
	readonly pattern: RegExp;
}

/**
 * The volatile values `normalize_differential_response` placeholders, applied
 * in order to every string (object keys included). Tokens come first, so the
 * random tail of a token is never read as a hash. A `blake3:<64 hex>` content
 * address matches none of them and is compared verbatim.
 */
export const VOLATILE_VALUE_PATTERNS: ReadonlyArray<VolatileValuePattern> = [
	// `API_TOKEN_PREFIX` + base64url
	{ kind: 'token', pattern: /secret_fuz_token_[A-Za-z0-9_-]+/g },
	// `API_TOKEN_ID_REGEX`, unanchored — the public id of an API token
	{ kind: 'token_id', pattern: /(?<![\w-])tok_[\w-]{12}(?![\w-])/g },
	{ kind: 'uuid', pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g },
	// `ISO8601_SECONDS`, unanchored
	{ kind: 'timestamp', pattern: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g },
	// bare digests only — a `blake3:` content address is compared verbatim
	{ kind: 'hash', pattern: /(?<!\w|blake3:)[0-9a-f]{64}(?!\w)/g }
];

/**
 * Normalize one response into its `DifferentialResponse`. Pure; numbering
 * restarts for every call.
 *
 * @param response - the raw status, header snapshot and JSON body
 * @returns the canonical form
 */
export const normalize_differential_response = (
	response: DifferentialRawResponse
): DifferentialResponse => {
	const seen = new Map<string, Map<string, string>>();
	const placeholder = (kind: string, value: string): string => {
		let values = seen.get(kind);
		if (!values) {
			values = new Map();
			seen.set(kind, values);
		}
		let p = values.get(value);
		if (p === undefined) {
			p = `<${kind}:${values.size + 1}>`;
			values.set(value, p);
		}
		return p;
	};
	const normalize_string = (value: string): string => {
		let out = value;
		for (const { kind, pattern } of VOLATILE_VALUE_PATTERNS) {
			out = out.replace(pattern, (match) => placeholder(kind, match));
		}
		return out;
	};
	const normalize_value = (value: unknown): unknown => {
		if (typeof value === 'string') return normalize_string(value);
		if (Array.isArray(value)) return value.map(normalize_value);
		if (value !== null && typeof value === 'object') {
			const out: Record<string, unknown> = {};
			for (const key of Object.keys(value).sort()) {
				out[normalize_string(key)] = normalize_value((value as Record<string, unknown>)[key]);
			}
			return out;
		}
		return value;
	};
	return {
		status: response.status,
		body: normalize_value(response.body),
		header_names: Object.keys(response.headers)
			.map((name) => name.toLowerCase())
			.filter((name) => !VOLATILE_HEADER_NAMES.includes(name))
			.sort()
	};
};

/**
 * One place two normalized responses differ. `path` is dotted from the
 * response root (`status`, `headers.x-example`, `body.error.data.reason`,
 * `body.result.accounts[0]`); `a` / `b` are the values on each side,
 * `undefined` where a side has nothing there. A header one side sent and the
 * other didn't is `headers.<name>`, with `true` on the side that sent it.
 * An object one side lacks is compared key by key, so each of its keys is its
 * own difference (`body.error.data.reason`, not the whole `body.error.data`);
 * an empty object against a missing one is a difference at the object's path.
 */
export interface DifferentialDiff {
	readonly path: string;
	readonly a: unknown;
	readonly b: unknown;
}

const is_record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);

const diff_values = (path: string, a: unknown, b: unknown, out: Array<DifferentialDiff>): void => {
	if (Array.isArray(a) && Array.isArray(b)) {
		const length = Math.max(a.length, b.length);
		for (let i = 0; i < length; i++) diff_values(`${path}[${i}]`, a[i], b[i], out);
		return;
	}
	// an object one side lacks diffs key by key, so a ledger path can name one key
	if ((is_record(a) && (is_record(b) || b === undefined)) || (a === undefined && is_record(b))) {
		const ra = a ?? {};
		const rb = b ?? {};
		// `{}` against nothing has no key to diff, but is still a difference
		if (a === undefined || b === undefined) {
			if (Object.keys(ra).length === 0 && Object.keys(rb).length === 0) {
				out.push({ path, a, b });
				return;
			}
		}
		const keys = [...new Set([...Object.keys(ra), ...Object.keys(rb)])].sort();
		for (const key of keys) diff_values(`${path}.${key}`, ra[key], rb[key], out);
		return;
	}
	if (!Object.is(a, b)) out.push({ path, a, b });
};

/**
 * Every place two normalized responses differ, in a stable order: status,
 * then header names, then the body depth-first with keys sorted. Empty when
 * the responses are equal.
 *
 * @param a - one backend's normalized response
 * @param b - the other's
 * @returns the differences
 */
export const diff_differential_responses = (
	a: DifferentialResponse,
	b: DifferentialResponse
): Array<DifferentialDiff> => {
	const out: Array<DifferentialDiff> = [];
	if (a.status !== b.status) out.push({ path: 'status', a: a.status, b: b.status });
	for (const name of [...new Set([...a.header_names, ...b.header_names])].sort()) {
		const in_a = a.header_names.includes(name);
		const in_b = b.header_names.includes(name);
		if (in_a !== in_b) {
			out.push({ path: `headers.${name}`, a: in_a || undefined, b: in_b || undefined });
		}
	}
	diff_values('body', a.body, b.body, out);
	return out;
};

/**
 * Whether `path` is `covered` or lies under it — `body.error.data` covers
 * `body.error.data.reason` and `body.error.data[0]`, not `body.error.database`.
 *
 * @param covered - a declared path
 * @param path - a `DifferentialDiff` path
 * @returns `true` when `path` is `covered` or under it
 */
export const differential_path_covers = (covered: string, path: string): boolean =>
	path === covered ||
	(path.startsWith(covered) && (path[covered.length] === '.' || path[covered.length] === '['));

/**
 * Render diffs one per line for an assertion message.
 *
 * @param diffs - the differences
 * @param labels - names for the two sides
 * @returns one indented `path: a=… b=…` line per diff
 */
export const format_differential_diffs = (
	diffs: ReadonlyArray<DifferentialDiff>,
	labels: { readonly a: string; readonly b: string }
): string =>
	diffs
		.map(
			(d) =>
				`  ${d.path}: ${labels.a}=${JSON.stringify(d.a) ?? 'undefined'} ` +
				`${labels.b}=${JSON.stringify(d.b) ?? 'undefined'}`
		)
		.join('\n');
