/**
 * Recording for the transcript differential (`transcript_differential.ts`):
 * every request a suite sends through its fixture, with the answer, pushed to
 * the window the registration opens per test.
 *
 * Two seams, both outside `src/lib/testing/`:
 *
 * - `transport` and `fresh_transport` are wrapped, so the recorded request is
 *   what the suite passed — the relative path, its own headers and body. The
 *   `Origin` and `Cookie` the transport adds inside are not seen. Each send
 *   is tagged with `TRANSCRIPT_RECORDED_HEADER`, which the `fetch` patch
 *   strips before it leaves.
 * - The fixture's helpers that send (`TranscriptFixtureHelper`:
 *   `create_account` and the dead-credential mints) send on transports of
 *   their own, which no wrapper reaches. Each call is wrapped instead and, in
 *   its async context (`AsyncLocalStorage`), the `fetch` patch records what
 *   reaches the wire — a `_testing_*` call aside — so those entries carry the
 *   transport-added header names too. They are marked `via` with the
 *   helper's name. Without them a minted account's ids would first appear in
 *   a later response, a signup or login that answers differently would go
 *   unseen, and a suite using a dead-credential principal would trip the
 *   tripwire below.
 *
 * The wrapped `setup_test` builds its fixture only inside a test's window,
 * counted there (`fixtures_built`), so a fixture shared across tests can't
 * send into whichever window is open, and a test that built none has no
 * fixture to send through.
 *
 * The patch is also the tripwire: while a window is open, any other untagged
 * `fetch`, to any origin, is a send the transcript can't see — listed in the
 * window's `unrecorded` for the registration to fail the test with — unless
 * its body is a JSON-RPC call of a `_testing_*` backdoor, which is never
 * recorded (the fixture sends them on its own transports: the per-test
 * `_testing_reset` inside `setup_test()`, before the fixture exists, and the
 * invariant check after the test). Constructing a `WebSocket` (or an
 * `EventSource`, where the runtime has one) while a window is open is listed
 * too. What reaches neither — the `ws` library, a raw socket — the tripwire
 * can't see; the import census (`transcript_census.test.ts`) keeps those out
 * of a transcript suite.
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { is_api_token_shaped, to_api_token_id } from '#lib/auth/api_token.ts';
import type { SetupTest, TestFixture } from '#lib/testing/cross_backend/setup.ts';
import type { FetchTransport } from '#lib/testing/transports/fetch_transport.ts';

/** One request and its answer, as the suite sent and read them. */
export interface TranscriptEntry {
	readonly request: {
		/** Absent for the suite's own requests; the fixture helper that sent it otherwise. */
		readonly via?: TranscriptFixtureHelper;
		readonly method: string;
		/** The path and query, never the absolute URL, whose port differs per backend. */
		readonly path: string;
		/** Sorted lowercased header names. */
		readonly header_names: ReadonlyArray<string>;
		/**
		 * The public id of the API token an `Authorization: Bearer` header
		 * carries (`to_bearer_token_id`), absent with none — what the
		 * normalizer reads the request's own token touch by.
		 */
		readonly bearer_token_id?: string;
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

/**
 * The public id of the API token an `Authorization: Bearer` header carries,
 * as both spines mint it (`to_api_token_id`) — or `null`
 * for no header, another scheme, or a value not token-shaped.
 *
 * @param headers - the request's headers
 */
export const to_bearer_token_id = (headers: Headers): string | null => {
	const value = headers.get('authorization');
	if (value === null || !value.startsWith('Bearer ')) return null;
	const token = value.slice('Bearer '.length);
	if (!is_api_token_shaped(token)) return null;
	return to_api_token_id(token);
};

/** The request fields every recorded entry derives from its headers. */
const request_header_fields = (
	headers: Headers
): { header_names: Array<string>; bearer_token_id?: string } => {
	const bearer_token_id = to_bearer_token_id(headers);
	return {
		header_names: header_names(headers),
		...(bearer_token_id !== null && { bearer_token_id })
	};
};

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
 * The header a recording wrapper tags its sends with, so the `fetch` patch
 * tells them from a send no wrapper saw; stripped before the request leaves.
 */
export const TRANSCRIPT_RECORDED_HEADER = 'x-fuz-transcript-recorded';

/** One test's recording, open from its `beforeEach` until it finishes. */
export interface TranscriptWindow {
	/** The backend the test runs against; stripped from the paths `create_account` sends. */
	readonly base_url: string;
	readonly entries: Array<TranscriptEntry>;
	/** How many fixtures the test built through the wrapped `setup_test`. */
	fixtures_built: number;
	/**
	 * The sends the recording couldn't see — `METHOD url` for an untagged
	 * `fetch` outside `create_account`, `WebSocket url` / `EventSource url` for
	 * a construction — the backend's origin left off the path.
	 */
	readonly unrecorded: Array<string>;
}

/**
 * The open test's window. Module state is safe because the cross projects
 * run one test at a time in one worker.
 */
let open_window: TranscriptWindow | null = null;

/**
 * The `TestFixture` helpers that send on transports of their own, each call
 * recorded in its async context with `via` its name. `record_setup_test`
 * wraps every one, so a required `mint_*` helper added to `TestFixture` fails
 * typecheck there until it is wrapped; a sending helper by any other name
 * trips the tripwire instead.
 */
export type TranscriptFixtureHelper = Extract<
	keyof TestFixture,
	'create_account' | `mint_${string}`
>;

/** The helper whose call's async context a send is in, if any. */
const in_fixture_helper: AsyncLocalStorage<TranscriptFixtureHelper> = new AsyncLocalStorage();

/** The globals the patch replaces. */
const PATCHED_GLOBALS = ['fetch', 'WebSocket', 'EventSource'] as const;

/**
 * Each patched global's own property on `globalThis` before the patch,
 * `undefined` for one it lacked — restored as it was, so the patch leaves no
 * property behind (the cross projects share one global scope across files).
 */
let originals: Readonly<
	Record<(typeof PATCHED_GLOBALS)[number], PropertyDescriptor | undefined>
> | null = null;

const require_window = (what: string): TranscriptWindow => {
	if (!open_window) throw new Error(`transcript: ${what} outside a recording test`);
	return open_window;
};

/**
 * Open the window a test records into. Needs `install_transcript_fetch_patch`.
 *
 * @param base_url - the backend's base URL, stripped from the paths
 *   `create_account` sends and from an unrecorded send's URL
 * @throws Error when the patch isn't installed or a window is already open
 */
export const open_transcript_window = (base_url: string): void => {
	if (!originals) throw new Error('transcript: the fetch patch is not installed');
	if (open_window) throw new Error('transcript: a window is already open');
	open_window = { base_url, entries: [], fixtures_built: 0, unrecorded: [] };
};

/**
 * Close the open window.
 *
 * @returns what the test recorded and sent unrecorded, `null` when no window was open
 */
export const close_transcript_window = (): TranscriptWindow | null => {
	const closed = open_window;
	open_window = null;
	return closed;
};

/** `url` less the window's base URL when it starts with it. */
const to_path = (url: string, base_url: string): string =>
	url.startsWith(`${base_url}/`) || url === base_url ? url.slice(base_url.length) : url;

/** Whether a parsed request body is a JSON-RPC call of a `_testing_*` backdoor. */
const is_backdoor_call = (body: unknown): boolean =>
	typeof body === 'object' &&
	body !== null &&
	typeof (body as { method?: unknown }).method === 'string' &&
	(body as { method: string }).method.startsWith('_testing_');

/** The constructor `globalThis[name]` holds, wrapped to list each construction in the open window. */
const wrap_socket_constructor = <T extends object>(name: string, target: T): T =>
	new Proxy(target, {
		construct: (t, args: Array<unknown>, new_target) => {
			const window = open_window;
			if (window) {
				const url = args[0] instanceof URL ? args[0].href : String(args[0]);
				window.unrecorded.push(`${name} ${to_path(url, window.base_url)}`);
			}
			return Reflect.construct(t as new (...a: Array<unknown>) => object, args, new_target);
		}
	});

/**
 * Patch `globalThis.fetch` (and `WebSocket`, and `EventSource` where defined)
 * for the transcript: a tagged send has its tag stripped; a `_testing_*`
 * call is never recorded; inside a fixture helper's call every other send is
 * recorded; with a window open, any other send is listed in its `unrecorded`.
 * With no window open everything passes straight through. Pair with
 * `uninstall_transcript_fetch_patch`.
 */
export const install_transcript_fetch_patch = (): void => {
	if (originals) return;
	const inner = globalThis.fetch;
	const g = globalThis as { WebSocket?: typeof globalThis.WebSocket; EventSource?: object };
	originals = {
		fetch: Object.getOwnPropertyDescriptor(globalThis, 'fetch'),
		WebSocket: Object.getOwnPropertyDescriptor(globalThis, 'WebSocket'),
		EventSource: Object.getOwnPropertyDescriptor(globalThis, 'EventSource')
	};
	if (g.WebSocket) g.WebSocket = wrap_socket_constructor('WebSocket', g.WebSocket);
	if (g.EventSource) g.EventSource = wrap_socket_constructor('EventSource', g.EventSource);
	globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		if (request.headers.has(TRANSCRIPT_RECORDED_HEADER)) {
			request.headers.delete(TRANSCRIPT_RECORDED_HEADER);
			return inner(request);
		}
		const window = open_window;
		if (!window) return inner(request);
		const body = parse_text(await request.clone().text());
		const path = to_path(request.url, window.base_url);
		if (is_backdoor_call(body)) return inner(request);
		const via = in_fixture_helper.getStore();
		if (via === undefined) {
			window.unrecorded.push(`${request.method} ${path}`);
			return inner(request);
		}
		if (!request.headers.has('accept-encoding'))
			request.headers.set('accept-encoding', IDENTITY_ENCODING['accept-encoding']);
		const entry: TranscriptEntry = {
			request: {
				via,
				method: request.method,
				path,
				...request_header_fields(request.headers),
				body
			},
			response: null
		};
		window.entries.push(entry);
		const res = await inner(request);
		entry.response = await read_response(res);
		return res;
	};
};

/** Restore what `install_transcript_fetch_patch` replaced. */
export const uninstall_transcript_fetch_patch = (): void => {
	if (!originals) return;
	for (const name of PATCHED_GLOBALS) {
		const descriptor = originals[name];
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else delete (globalThis as Record<string, unknown>)[name];
	}
	originals = null;
};

/**
 * Wrap a transport so each request it sends, and its answer, lands in the
 * open window, the send tagged with `TRANSCRIPT_RECORDED_HEADER`. The entry
 * is pushed before the send, so order holds even if a suite sends
 * concurrently.
 *
 * @param transport - the fixture's transport
 * @returns a transport with the same jar
 */
export const record_transport = (transport: FetchTransport): FetchTransport => {
	const recorded = (async (url: string, init: RequestInit): Promise<Response> => {
		const { entries } = require_window('a request was sent');
		const headers = new Headers(init.headers);
		if (!headers.has('accept-encoding'))
			headers.set('accept-encoding', IDENTITY_ENCODING['accept-encoding']);
		const entry: TranscriptEntry = {
			request: {
				method: (init.method ?? 'GET').toUpperCase(),
				path: url,
				...request_header_fields(headers),
				body: request_body(init.body)
			},
			response: null
		};
		entries.push(entry);
		headers.set(TRANSCRIPT_RECORDED_HEADER, '1');
		const res = await transport(url, { ...init, headers });
		entry.response = await read_response(res);
		return res;
	}) as FetchTransport;
	Object.defineProperty(recorded, 'cookies', { value: transport.cookies, enumerable: false });
	return recorded;
};

/**
 * Wrap a `SetupTest` so the fixture it returns records into the open window,
 * its `TranscriptFixtureHelper`s included (needs
 * `install_transcript_fetch_patch`), and counts in the window's
 * `fixtures_built`.
 *
 * @param setup_test - the per-test fixture producer
 * @returns the recording producer, which throws outside a test's window
 */
export const record_setup_test =
	(setup_test: SetupTest): SetupTest =>
	async (): Promise<TestFixture> => {
		require_window('a fixture was built').fixtures_built++;
		const fixture = await setup_test();
		const in_helper = <T>(helper: TranscriptFixtureHelper, call: () => Promise<T>): Promise<T> => {
			require_window(helper);
			return in_fixture_helper.run(helper, call);
		};
		const helpers: Pick<TestFixture, TranscriptFixtureHelper> = {
			create_account: (o) => in_helper('create_account', () => fixture.create_account(o)),
			mint_expired_session: () =>
				in_helper('mint_expired_session', () => fixture.mint_expired_session()),
			mint_revoked_session: () =>
				in_helper('mint_revoked_session', () => fixture.mint_revoked_session()),
			mint_revoked_token: () => in_helper('mint_revoked_token', () => fixture.mint_revoked_token()),
			mint_expired_token: () => in_helper('mint_expired_token', () => fixture.mint_expired_token())
		};
		return {
			...fixture,
			transport: record_transport(fixture.transport),
			fresh_transport: (o) => record_transport(fixture.fresh_transport(o)),
			...helpers
		};
	};
