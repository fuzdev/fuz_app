import { describe, test, assert, vi } from 'vitest';
import type { Logger } from '@fuzdev/fuz_util/log.ts';
import { create_uuid } from '@fuzdev/fuz_util/id.ts';

import { PendingPeerRequests, audit_unmatched_peer_response } from '$lib/actions/peer_request.ts';
import {
	create_jsonrpc_response,
	create_jsonrpc_error_response
} from '$lib/http/jsonrpc_helpers.ts';
import { jsonrpc_error_messages } from '$lib/http/jsonrpc_errors.ts';

describe('PendingPeerRequests', () => {
	test('register allocates namespaced ids and resolve delivers the success value', async () => {
		const pending = new PendingPeerRequests();
		const conn = create_uuid();
		const reg = pending.register(conn);
		assert.ok(reg);
		assert.strictEqual(reg.id, 's1', 'server ids are `s`-namespaced + monotonic');
		assert.strictEqual(pending.size(conn), 1);
		assert.ok(pending.resolve(conn, create_jsonrpc_response(reg.id, { nonce: 1 })));
		assert.deepStrictEqual(await reg.outcome, { ok: true, value: { nonce: 1 } });
		assert.strictEqual(pending.size(), 0, 'resolve removes the entry');
	});

	test('a client error reply forwards the envelope verbatim', async () => {
		const pending = new PendingPeerRequests();
		const conn = create_uuid();
		const reg = pending.register(conn);
		assert.ok(reg);
		const err = jsonrpc_error_messages.internal_error('nope');
		assert.ok(pending.resolve(conn, create_jsonrpc_error_response(reg.id, err)));
		const outcome = await reg.outcome;
		assert.ok(!outcome.ok);
		assert.strictEqual(outcome.error.kind, 'client_error');
		if (outcome.error.kind === 'client_error') {
			assert.deepStrictEqual(outcome.error.error, err);
		}
	});

	test('resolution is per-connection isolated', () => {
		const pending = new PendingPeerRequests();
		const a = create_uuid();
		const b = create_uuid();
		const reg = pending.register(a);
		assert.ok(reg);
		// A reply arriving on connection B for A's id must resolve nothing.
		assert.isFalse(pending.resolve(b, create_jsonrpc_response(reg.id, {})));
		assert.strictEqual(pending.size(a), 1, 'A stays pending');
	});

	test('resolve rejects unknown and already-settled ids', async () => {
		const pending = new PendingPeerRequests();
		const conn = create_uuid();
		const reg = pending.register(conn);
		assert.ok(reg);
		assert.isFalse(pending.resolve(conn, create_jsonrpc_response('s9999', {})), 'never-issued id');
		assert.ok(pending.resolve(conn, create_jsonrpc_response(reg.id, {})));
		assert.isFalse(
			pending.resolve(conn, create_jsonrpc_response(reg.id, {})),
			'already-settled id'
		);
		await reg.outcome;
	});

	test('the per-connection cap returns null past the bound; other connections keep their own budget', () => {
		const pending = new PendingPeerRequests({ max_in_flight_per_connection: 2 });
		const a = create_uuid();
		const b = create_uuid();
		assert.ok(pending.register(a));
		assert.ok(pending.register(a));
		assert.isNull(pending.register(a), 'third over the cap');
		assert.ok(pending.register(b), 'a different connection has its own budget');
	});

	test('drain settles every pending request on a connection as connection_gone', async () => {
		const pending = new PendingPeerRequests();
		const conn = create_uuid();
		const reg1 = pending.register(conn);
		const reg2 = pending.register(conn);
		assert.ok(reg1);
		assert.ok(reg2);
		pending.drain(conn);
		assert.strictEqual(pending.size(conn), 0);
		assert.deepStrictEqual(await reg1.outcome, { ok: false, error: { kind: 'connection_gone' } });
		assert.deepStrictEqual(await reg2.outcome, { ok: false, error: { kind: 'connection_gone' } });
		// The inner map was removed, so the connection can register again.
		assert.ok(pending.register(conn));
	});

	test('settle force-resolves an entry and is idempotent', async () => {
		const pending = new PendingPeerRequests();
		const conn = create_uuid();
		const reg = pending.register(conn);
		assert.ok(reg);
		pending.settle(conn, reg.id, { ok: false, error: { kind: 'connection_gone' } });
		// A second settle (or a late reply) is a no-op — the entry is already gone.
		pending.settle(conn, reg.id, { ok: true, value: { late: true } });
		assert.deepStrictEqual(await reg.outcome, { ok: false, error: { kind: 'connection_gone' } });
	});

	test('a request resolves timeout when no reply arrives before the deadline', async () => {
		vi.useFakeTimers();
		try {
			const pending = new PendingPeerRequests({ default_timeout_ms: 1000 });
			const conn = create_uuid();
			const reg = pending.register(conn);
			assert.ok(reg);
			await vi.advanceTimersByTimeAsync(1000);
			assert.deepStrictEqual(await reg.outcome, { ok: false, error: { kind: 'timeout' } });
			assert.strictEqual(pending.size(), 0, 'the timed-out entry is cleaned up');
		} finally {
			vi.useRealTimers();
		}
	});

	test('a per-call timeout_ms overrides the default', async () => {
		vi.useFakeTimers();
		try {
			const pending = new PendingPeerRequests({ default_timeout_ms: 10_000 });
			const conn = create_uuid();
			const reg = pending.register(conn, 50);
			assert.ok(reg);
			await vi.advanceTimersByTimeAsync(50);
			assert.deepStrictEqual(await reg.outcome, { ok: false, error: { kind: 'timeout' } });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('audit_unmatched_peer_response', () => {
	test('warns on the first 8 then samples out the rest (bounded — DoS-safe)', () => {
		const calls: Array<ReadonlyArray<unknown>> = [];
		const log = {
			warn: (...args: Array<unknown>): void => void calls.push(args)
		} as unknown as Logger;
		const conn = create_uuid();
		// This is the only caller of the module-scope counter in this file, so it
		// starts at 0: the first 8 (n=0..7) warn, the 9th (n=8) is sampled out.
		for (let i = 0; i < 8; i++) audit_unmatched_peer_response(log, conn, `s${i}`);
		assert.strictEqual(calls.length, 8, 'first 8 unmatched responses warn');
		audit_unmatched_peer_response(log, conn, 's8');
		assert.strictEqual(calls.length, 8, 'the 9th is sampled out (1-in-256 thereafter)');
	});
});
