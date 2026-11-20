/**
 * Recording for the transcript differential (`transcript_differential.ts`):
 * every request a suite sends through its fixture, with the answer, pushed to
 * a sink the registration opens per test.
 *
 * Two seams, both outside `src/lib/testing/`:
 *
 * - `transport` and `fresh_transport` are wrapped, so the recorded request is
 *   what the suite passed — the relative path, its own headers and body. The
 *   `Origin` and `Cookie` the transport adds inside are not seen.
 * - `create_account` sends its invite, signup, login and token mint on
 *   transports of its own, which no wrapper reaches. The call is wrapped
 *   instead and, while it runs, `globalThis.fetch` is patched to record what
 *   reaches the wire, so those entries carry the transport-added header names
 *   too. They are marked `via: 'create_account'`. Without them a minted
 *   account's ids would first appear in a later response, and a signup or
 *   login that answers differently would go unseen.
 *
 * The per-test `_testing_reset` runs inside `setup_test()` before the fixture
 * exists, on the handle's own transport, and is never recorded.
 *
 * @module
 */

import type { SetupTest, TestFixture } from '#lib/testing/cross_backend/setup.ts';
import type { FetchTransport } from '#lib/testing/transports/fetch_transport.ts';

/** One request and its answer, as the suite sent and read them. */
export interface TranscriptEntry {
	readonly request: {
		/** Absent for the suite's own requests; `'create_account'` for the fixture's mint. */
		readonly via?: 'create_account';
		readonly method: string;
		/** The path and query, never the absolute URL, whose port differs per backend. */
		readonly path: string;
		/** Sorted lowercased header names. */
		readonly header_names: ReadonlyArray<string>;
		/** Parsed JSON when the body text parses, else the text, `null` with none. */
		readonly body: unknown;
	};
	/** Filled once the answer arrives; `null` when the send threw. */
	response: {
		readonly status: number;
		/** Every header by lowercased name, as `Headers` joins repeated lines. */
		readonly headers: Readonly<Record<string, string>>;
		readonly set_cookies: ReadonlyArray<string>;
		/** Parsed JSON, else the text; `'<event-stream>'` for a stream, never read. */
		readonly body: unknown;
	} | null;
}

/** Where a recording test's entries go; `null` outside one. */
export type TranscriptSink = () => Array<TranscriptEntry> | null;

/**
 * Sent on every recorded request that names no `accept-encoding`, as the
 * conformance differential does, so a runtime's own compression never reads
 * as a header difference.
 */
const IDENTITY_ENCODING = { 'accept-encoding': 'identity' };

const parse_text = (text: string): unknown => {
	if (text === '') return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
};

const header_names = (headers: Headers): Array<string> => [...headers.keys()].sort();

const read_response = async (res: Response): Promise<NonNullable<TranscriptEntry['response']>> => {
	const content_type = res.headers.get('content-type') ?? '';
	return {
		status: res.status,
		headers: Object.fromEntries(res.headers),
		set_cookies: res.headers.getSetCookie(),
		body: content_type.includes('text/event-stream')
			? '<event-stream>'
			: parse_text(await res.clone().text())
	};
};

const request_body = (body: RequestInit['body']): unknown =>
	body === undefined || body === null
		? null
		: typeof body === 'string'
			? parse_text(body)
			: `<${Object.prototype.toString.call(body)}>`;

/**
 * Wrap a transport so each request it sends, and its answer, lands in the
 * sink. The entry is pushed before the send, so order holds even if a suite
 * sends concurrently.
 *
 * @param transport - the fixture's transport
 * @param sink - the open test's entries
 * @returns a transport with the same jar
 */
export const record_transport = (
	transport: FetchTransport,
	sink: TranscriptSink
): FetchTransport => {
	const recorded = (async (url: string, init: RequestInit): Promise<Response> => {
		const entries = sink();
		if (!entries) throw new Error('transcript: a request was sent outside a recording test');
		const headers = new Headers(init.headers);
		if (!headers.has('accept-encoding'))
			headers.set('accept-encoding', IDENTITY_ENCODING['accept-encoding']);
		const entry: TranscriptEntry = {
			request: {
				method: (init.method ?? 'GET').toUpperCase(),
				path: url,
				header_names: header_names(headers),
				body: request_body(init.body)
			},
			response: null
		};
		entries.push(entry);
		const res = await transport(url, { ...init, headers });
		entry.response = await read_response(res);
		return res;
	}) as FetchTransport;
	Object.defineProperty(recorded, 'cookies', { value: transport.cookies, enumerable: false });
	return recorded;
};

/**
 * While set, `globalThis.fetch` records into it: the window of one
 * `create_account` call. Module state is safe because the cross projects run
 * one test at a time in one worker.
 */
let create_account_recording: { base_url: string; entries: Array<TranscriptEntry> } | null = null;

let original_fetch: typeof fetch | null = null;

/**
 * Patch `globalThis.fetch` to record while a `create_account` call is open.
 * Outside that window it passes straight through. Pair with
 * `uninstall_create_account_recorder`.
 */
export const install_create_account_recorder = (): void => {
	if (original_fetch) return;
	const inner = globalThis.fetch;
	original_fetch = inner;
	globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
		const recording = create_account_recording;
		if (!recording) return inner(input, init);
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const headers = new Headers(init?.headers);
		if (!headers.has('accept-encoding'))
			headers.set('accept-encoding', IDENTITY_ENCODING['accept-encoding']);
		const entry: TranscriptEntry = {
			request: {
				via: 'create_account',
				method: (init?.method ?? 'GET').toUpperCase(),
				path: url.startsWith(recording.base_url) ? url.slice(recording.base_url.length) : url,
				header_names: header_names(headers),
				body: request_body(init?.body)
			},
			response: null
		};
		recording.entries.push(entry);
		const res = await inner(input, { ...init, headers });
		entry.response = await read_response(res);
		return res;
	};
};

/** Restore the `fetch` `install_create_account_recorder` replaced. */
export const uninstall_create_account_recorder = (): void => {
	if (!original_fetch) return;
	globalThis.fetch = original_fetch;
	original_fetch = null;
};

/**
 * Wrap a `SetupTest` so the fixture it returns records into the sink, its
 * `create_account` included (needs `install_create_account_recorder`).
 *
 * @param setup_test - the per-test fixture producer
 * @param sink - the open test's entries
 * @param base_url - the backend's base URL, stripped from the paths `create_account` sends
 * @returns the recording producer
 */
export const record_setup_test =
	(setup_test: SetupTest, sink: TranscriptSink, base_url: string): SetupTest =>
	async (): Promise<TestFixture> => {
		const fixture = await setup_test();
		return {
			...fixture,
			transport: record_transport(fixture.transport, sink),
			fresh_transport: (o) => record_transport(fixture.fresh_transport(o), sink),
			create_account: async (o) => {
				const entries = sink();
				if (!entries) throw new Error('transcript: create_account outside a recording test');
				if (!original_fetch) throw new Error('transcript: create_account recorder not installed');
				create_account_recording = { base_url, entries };
				try {
					return await fixture.create_account(o);
				} finally {
					create_account_recording = null;
				}
			}
		};
	};
