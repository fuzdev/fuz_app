import { afterEach, assert, beforeEach, describe, test } from 'vitest';

import type { TestFixture } from '#lib/testing/cross_backend/setup.ts';
import type { TestAccount } from '#lib/testing/test_app.ts';
import { create_fetch_transport } from '#lib/testing/transports/fetch_transport.ts';

import {
	entry_matches_where,
	find_recording_problems,
	type TranscriptEntryWhere
} from './transcript_differential.ts';
import { normalize_transcript, OWN_TOUCH } from './transcript_normalize.ts';
import {
	close_transcript_window,
	install_transcript_fetch_patch,
	open_transcript_window,
	record_setup_test,
	record_transport,
	to_bearer_token_id,
	TRANSCRIPT_RECORDED_HEADER,
	uninstall_transcript_fetch_patch,
	type TranscriptEntry,
	type TranscriptWindow
} from './transcript_record.ts';

const patched_global_descriptors = () =>
	Object.fromEntries(
		(['fetch', 'WebSocket', 'EventSource'] as const).map((n) => [
			n,
			Object.getOwnPropertyDescriptor(globalThis, n)
		])
	);

/** The patched globals as the file found them, before any install. */
const INITIAL_GLOBALS = patched_global_descriptors();

const entry = (status: number, body: unknown): Record<string, unknown> => ({
	request: { method: 'POST', path: '/api/rpc' },
	response: { status, body }
});

const rpc_error = (code: number, reason?: string) => ({
	jsonrpc: '2.0',
	id: 1,
	error: { code, message: 'm', ...(reason !== undefined && { data: { reason } }) }
});

describe('entry_matches_where', () => {
	test('a REST row matches the error code at the status', () => {
		const where = { status: 400, body_error: ['invalid_request_body'] };
		assert.ok(entry_matches_where(where, entry(400, { error: 'invalid_request_body' })));
		assert.ok(!entry_matches_where(where, entry(401, { error: 'invalid_request_body' })));
		assert.ok(!entry_matches_where(where, entry(400, { error: 'other' })));
		assert.ok(!entry_matches_where(where, entry(400, rpc_error(-32602, 'invalid_request_body'))));
		assert.ok(!entry_matches_where(where, undefined));
	});

	test('an RPC row matches the JSON-RPC error code, narrowed by its reason', () => {
		const by_code = { status: 400, rpc_code: [-32602] };
		assert.ok(entry_matches_where(by_code, entry(400, rpc_error(-32602))));
		assert.ok(entry_matches_where(by_code, entry(400, rpc_error(-32602, 'params_nul'))));
		assert.ok(!entry_matches_where(by_code, entry(400, rpc_error(-32600))));
		assert.ok(!entry_matches_where(by_code, entry(403, rpc_error(-32602))));
		assert.ok(!entry_matches_where(by_code, entry(400, { error: 'invalid_params' })));
		const by_reason = { status: 400, rpc_code: [-32602], rpc_reason: ['params_nul'] };
		assert.ok(entry_matches_where(by_reason, entry(400, rpc_error(-32602, 'params_nul'))));
		assert.ok(!entry_matches_where(by_reason, entry(400, rpc_error(-32602, 'other'))));
		assert.ok(!entry_matches_where(by_reason, entry(400, rpc_error(-32602))));
	});
});

test('a where row is REST or JSON-RPC, never both', () => {
	// @ts-expect-error the arms exclude each other
	const both: TranscriptEntryWhere = { status: 400, body_error: ['x'], rpc_code: [-32602] };
	// @ts-expect-error a reason narrows a JSON-RPC code only
	const reason_alone: TranscriptEntryWhere = { status: 400, body_error: ['x'], rpc_reason: ['y'] };
	assert.ok(both && reason_alone);
});

describe('find_recording_problems', () => {
	const own = {
		request: { method: 'GET', path: '/x', header_names: [], body: null },
		response: null
	};
	const minted = { ...own, request: { ...own.request, via: 'create_account' as const } };
	const window = (overrides: Partial<TranscriptWindow>): TranscriptWindow => ({
		base_url: 'http://localhost:1',
		entries: [],
		fixtures_built: 1,
		unrecorded: [],
		...overrides
	});

	test('a passing test with none of its own sends recorded is a problem', () => {
		assert.strictEqual(find_recording_problems(window({}), 'pass').length, 1);
		// `create_account`'s sends are the fixture's, not the test's
		assert.strictEqual(find_recording_problems(window({ entries: [minted] }), 'pass').length, 1);
		assert.deepEqual(find_recording_problems(window({ entries: [minted, own] }), 'pass'), []);
	});

	test('a passing test that built no fixture had nothing to send through', () => {
		assert.deepEqual(find_recording_problems(window({ fixtures_built: 0 }), 'pass'), []);
		// what it sends anyway is the tripwire's
		const unrecorded = ['GET /api/rpc'];
		assert.strictEqual(
			find_recording_problems(window({ fixtures_built: 0, unrecorded }), 'pass').length,
			1
		);
	});

	test('a failed or skipped test that recorded nothing is already accounted for', () => {
		assert.deepEqual(find_recording_problems(window({}), 'fail'), []);
		assert.deepEqual(find_recording_problems(window({}), 'skip'), []);
	});

	test('an unrecorded send is a problem whatever the outcome, naming it', () => {
		const unrecorded = ['GET /api/rpc'];
		for (const outcome of ['pass', 'fail', 'skip'] as const) {
			const problems = find_recording_problems(window({ unrecorded, entries: [own] }), outcome);
			assert.ok(problems.some((p) => p.includes('GET /api/rpc')));
		}
	});
});

describe('the transcript fetch patch', () => {
	const BASE_URL = 'http://localhost:1';
	const sent: Array<Request> = [];
	let original_fetch: typeof fetch;
	let original_websocket: typeof WebSocket;
	const constructed: Array<string> = [];

	beforeEach(() => {
		original_fetch = globalThis.fetch;
		original_websocket = globalThis.WebSocket;
		globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
			sent.push(new Request(input, init));
			return new Response('{}', { headers: { 'content-type': 'application/json' } });
		};
		// a stand-in that opens nothing
		globalThis.WebSocket = function (this: object, url: string | URL) {
			constructed.push(String(url));
		} as unknown as typeof WebSocket;
		install_transcript_fetch_patch();
		open_transcript_window(BASE_URL);
	});

	afterEach(() => {
		close_transcript_window();
		uninstall_transcript_fetch_patch();
		globalThis.fetch = original_fetch;
		globalThis.WebSocket = original_websocket;
		sent.length = 0;
		constructed.length = 0;
	});

	test('a recorded send is tagged, and the tag is stripped before it leaves', async () => {
		const transport = record_transport(create_fetch_transport({ base_url: BASE_URL }));
		await transport('/api/rpc', { method: 'POST', body: '{"method":"x"}' });
		const window = close_transcript_window();
		assert.ok(window);
		assert.strictEqual(window.entries.length, 1);
		assert.deepEqual(window.unrecorded, []);
		assert.strictEqual(sent.length, 1);
		assert.ok(!sent[0]!.headers.has(TRANSCRIPT_RECORDED_HEADER));
		assert.ok(!window.entries[0]!.request.header_names.includes(TRANSCRIPT_RECORDED_HEADER));
	});

	test('an untagged send to any origin trips; a backdoor call does not', async () => {
		await fetch(`${BASE_URL}/api/rpc`, { method: 'GET' });
		await fetch(`${BASE_URL}/api/rpc`, {
			method: 'POST',
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: '_testing_reset' })
		});
		// the same backend under another name
		await fetch('http://127.0.0.1:1/api/rpc');
		await fetch('http://localhost:12/api/rpc');
		const window = close_transcript_window();
		assert.ok(window);
		assert.deepEqual(window.unrecorded, [
			'GET /api/rpc',
			'GET http://127.0.0.1:1/api/rpc',
			'GET http://localhost:12/api/rpc'
		]);
		assert.deepEqual(window.entries, []);
		assert.strictEqual(sent.length, 4);
	});

	test('a Request input is read for its tag, method and body', async () => {
		await fetch(
			new Request(`${BASE_URL}/api/rpc`, {
				method: 'POST',
				headers: { [TRANSCRIPT_RECORDED_HEADER]: '1' },
				body: '{}'
			})
		);
		await fetch(new Request(`${BASE_URL}/api/rpc`, { method: 'POST', body: '{}' }));
		await fetch(
			new Request(`${BASE_URL}/api/rpc`, {
				method: 'POST',
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: '_testing_drain_effects' })
			})
		);
		const window = close_transcript_window();
		assert.ok(window);
		assert.deepEqual(window.unrecorded, ['POST /api/rpc']);
		assert.ok(!sent[0]!.headers.has(TRANSCRIPT_RECORDED_HEADER));
		assert.strictEqual(sent.length, 3);
	});

	test('a WebSocket constructed while a window is open trips', () => {
		const sockets = [new WebSocket('ws://localhost:1/api/ws')];
		const window = close_transcript_window();
		sockets.push(new WebSocket('ws://localhost:1/api/ws'));
		assert.ok(window);
		assert.deepEqual(window.unrecorded, ['WebSocket ws://localhost:1/api/ws']);
		assert.strictEqual(constructed.length, 2);
	});

	test("create_account's sends are recorded; a send beside it in flight still trips", async () => {
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		const fixture = {
			transport: create_fetch_transport({ base_url: BASE_URL }),
			fresh_transport: () => create_fetch_transport({ base_url: BASE_URL }),
			create_account: async () => {
				await fetch(`${BASE_URL}/api/account/signup`, { method: 'POST', body: '{}' });
				await held;
				await fetch(`${BASE_URL}/api/account/login`, { method: 'POST', body: '{}' });
				return {} as TestAccount;
			}
		} as unknown as TestFixture;
		const recording = await record_setup_test(async () => fixture)();
		const minting = recording.create_account();
		// sent while the mint is in flight, outside its async context
		await fetch(`${BASE_URL}/api/rpc`);
		release();
		await minting;
		const window = close_transcript_window();
		assert.ok(window);
		assert.deepEqual(
			window.entries.map((e) => [e.request.via, e.request.path]),
			[
				['create_account', '/api/account/signup'],
				['create_account', '/api/account/login']
			]
		);
		assert.deepEqual(window.unrecorded, ['GET /api/rpc']);
	});

	test('a fixture is counted in the window it is built in, and refused outside one', async () => {
		const fixture = {
			transport: create_fetch_transport({ base_url: BASE_URL }),
			fresh_transport: () => create_fetch_transport({ base_url: BASE_URL })
		} as unknown as TestFixture;
		const setup_test = record_setup_test(async () => fixture);
		await setup_test();
		await setup_test();
		assert.strictEqual(close_transcript_window()?.fixtures_built, 2);
		let error: unknown;
		await setup_test().catch((e: unknown) => (error = e));
		assert.ok(error instanceof Error && error.message.includes('outside a recording test'));
	});

	test("a recorded request names its bearer token's public id", async () => {
		const token = `secret_fuz_token_${'Ab1_-'.repeat(8)}xyz`;
		const transport = record_transport(create_fetch_transport({ base_url: BASE_URL }));
		await transport('/api/rpc', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
		await transport('/api/rpc', { method: 'POST' });
		const window = close_transcript_window();
		assert.deepEqual(
			window?.entries.map((e) => e.request.bearer_token_id),
			['tok_Ab1_-Ab1_-Ab', undefined]
		);
	});

	test('with no window open, a send passes through untouched', async () => {
		close_transcript_window();
		await fetch(`${BASE_URL}/api/rpc`);
		assert.strictEqual(sent.length, 1);
	});
});

describe('uninstalling the transcript patch', () => {
	test('restores each global as it was at load, adding none it lacked', () => {
		// every earlier install and uninstall in this file ran before this,
		// so a property one of them left behind shows here too
		assert.deepEqual(patched_global_descriptors(), INITIAL_GLOBALS);
		install_transcript_fetch_patch();
		assert.notStrictEqual(globalThis.fetch, INITIAL_GLOBALS.fetch?.value);
		uninstall_transcript_fetch_patch();
		assert.deepEqual(patched_global_descriptors(), INITIAL_GLOBALS);
	});

	test('a global EventSource is wrapped, and restored', () => {
		const fake = function () {};
		Object.defineProperty(globalThis, 'EventSource', {
			value: fake,
			writable: true,
			configurable: true
		});
		try {
			install_transcript_fetch_patch();
			assert.notStrictEqual((globalThis as { EventSource?: unknown }).EventSource, fake);
			uninstall_transcript_fetch_patch();
			assert.strictEqual((globalThis as { EventSource?: unknown }).EventSource, fake);
		} finally {
			const initial = INITIAL_GLOBALS.EventSource;
			if (initial) Object.defineProperty(globalThis, 'EventSource', initial);
			else delete (globalThis as { EventSource?: unknown }).EventSource;
		}
	});
});

describe('to_bearer_token_id', () => {
	const of = (authorization?: string) =>
		to_bearer_token_id(new Headers(authorization === undefined ? {} : { authorization }));

	test("a token's public id is `tok_` and its first twelve random characters", () => {
		assert.strictEqual(
			of(`Bearer secret_fuz_token_${'a'.repeat(12)}${'b'.repeat(31)}`),
			'tok_aaaaaaaaaaaa'
		);
	});

	test('no header, another scheme or a value not token-shaped names none', () => {
		assert.strictEqual(of(), null);
		assert.strictEqual(of(`Basic secret_fuz_token_${'a'.repeat(43)}`), null);
		assert.strictEqual(of('Bearer secret_fuz_token_short'), null);
	});
});

describe('normalize_transcript: a token touch read by its own request', () => {
	const token_row = (id: string, last_used_at: string | null) => ({
		id,
		last_used_at,
		last_used_ip: last_used_at && '127.0.0.1',
		created_at: '2026-01-01T00:00:00Z'
	});
	const list = (bearer_token_id: string | undefined, tokens: Array<unknown>): TranscriptEntry => ({
		request: {
			method: 'POST',
			path: '/api/rpc',
			header_names: ['authorization'],
			...(bearer_token_id !== undefined && { bearer_token_id }),
			body: null
		},
		response: {
			status: 200,
			headers: {},
			set_cookies: [],
			body: { result: { tokens } }
		}
	});
	const tokens_of = (entries: Array<TranscriptEntry>, index: number) =>
		(
			normalize_transcript(entries, 'fuz_session').entries[index] as {
				response: { body: { result: { tokens: Array<Record<string, unknown>> } } };
			}
		).response.body.result.tokens;

	test("the token's own row reads its touch as OWN_TOUCH, touched or not", () => {
		const own = 'tok_aaaaaaaaaaaa';
		for (const last_used_at of [null, '2026-01-01T00:00:00Z']) {
			const [row] = tokens_of([list(own, [token_row(own, last_used_at)])], 0);
			assert.strictEqual(row!.last_used_at, OWN_TOUCH);
			assert.strictEqual(row!.last_used_ip, OWN_TOUCH);
		}
	});

	test("another token's row, and every row of a request with no token, compares", () => {
		const own = 'tok_aaaaaaaaaaaa';
		const other = 'tok_bbbbbbbbbbbb';
		const [, row] = tokens_of(
			[list(own, [token_row(own, null), token_row(other, '2026-01-01T00:00:00Z')])],
			0
		);
		assert.strictEqual(row!.last_used_ip, '127.0.0.1');
		const [untouched] = tokens_of([list(undefined, [token_row(own, null)])], 0);
		assert.strictEqual(untouched!.last_used_at, null);
	});
});
