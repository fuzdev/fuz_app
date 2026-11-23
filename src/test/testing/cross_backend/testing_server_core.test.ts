/**
 * Unit tests for `testing_server_core.ts`: `is_loopback_bind_host` — the
 * security predicate fencing the test-server binary to loopback — and
 * `start_testing_server`'s shutdown exit code.
 *
 * The binary ships deterministic dev secrets (fixed cookie keys + bootstrap
 * token), so binding any network-reachable interface lets anyone who knows
 * those keys forge cookies against it. The predicate is an allowlist (not an
 * `0.0.0.0`/`::` blocklist) precisely so a concrete LAN/public interface IP
 * can't slip through; these cases pin that envelope.
 *
 * The shutdown exits `0` only when the app's close drained everything, and
 * `1` when it gave up on work still running or threw — so the cross-backend
 * teardown, which holds each spawned spine to exit `0`, sees a shutdown that
 * went wrong. Twin of the Rust spine's `StartupError::ShutdownGivenUp`, which
 * exits `1`.
 *
 * @module
 */

import { test, assert, describe } from 'vitest';
import { Hono } from 'hono';
import { create_deferred, wait } from '@fuzdev/fuz_util/async.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import {
	is_loopback_bind_host,
	start_testing_server,
	type BuiltTestingApp,
	type TestingServerAdapter
} from '#lib/testing/cross_backend/testing_server_core.ts';
import { create_mock_runtime, MockExitError } from '#lib/runtime/mock.ts';
import type { ShutdownDrainGivenUp } from '#lib/server/shutdown_drain.ts';

describe('is_loopback_bind_host', () => {
	test('accepts loopback hosts', () => {
		for (const host of [
			'localhost',
			'127.0.0.1',
			'127.0.0.2', // all of 127.0.0.0/8 is loopback
			'127.255.255.255',
			'::1',
			'[::1]' // bracketed IPv6 literal
		]) {
			assert.ok(is_loopback_bind_host(host), `${host} should be accepted as loopback`);
		}
	});

	test('refuses wildcard bind hosts (the original blocklist set)', () => {
		for (const host of ['0.0.0.0', '::', '[::]']) {
			assert.ok(!is_loopback_bind_host(host), `${host} must be refused`);
		}
	});

	test('refuses concrete non-loopback IPs (the gap an allowlist closes)', () => {
		for (const host of ['192.168.1.50', '10.0.0.1', '172.16.0.1', '8.8.8.8', '0.0.0.1']) {
			assert.ok(!is_loopback_bind_host(host), `${host} is network-reachable and must be refused`);
		}
	});

	test('refuses a DNS name that merely starts with `127.`', () => {
		// The IPv4 arm is a strict dotted-quad match, not a prefix check, so a
		// resolvable name like this can't masquerade as loopback.
		assert.ok(!is_loopback_bind_host('127.evil.example.com'));
	});
});

const log = new Logger('test', { level: 'off' });

const CLEAN: ShutdownDrainGivenUp = { requests: 0, audit_writes: 0, upkeep: 0 };

interface Signalled {
	/** The exit codes the adapter saw, in order. */
	exits: Array<number>;
	/** Settles when the first exit is called. */
	exited: Promise<void>;
	/** The shutdown handler's own promise, which ends in the exit's throw. */
	handled: Promise<void>;
}

/**
 * Start a testing server over a fake adapter whose app closes with `close`
 * and whose listener drains with `listener_shutdown`, and fire its shutdown
 * signal without waiting for it.
 */
const signal_shutdown = async (
	close: BuiltTestingApp['close'],
	listener_shutdown: () => Promise<void> = async () => {}
): Promise<Signalled> => {
	const runtime = create_mock_runtime();
	runtime.mock_env.set('HOME', '/home/test');
	const exits: Array<number> = [];
	const exited = create_deferred<void>();
	let on_signal: (() => Promise<void>) | null = null;
	const adapter: TestingServerAdapter = {
		runtime_label: 'fake',
		runtime,
		get_connection_ip: () => undefined,
		prepare_websocket: () => {
			throw new Error('no websocket in this test');
		},
		serve: () => ({ shutdown: listener_shutdown }),
		pid: 4242,
		register_shutdown_signals: (handler) => {
			on_signal = handler;
		},
		exit: (code) => {
			exits.push(code);
			exited.resolve();
			throw new MockExitError(code);
		}
	};
	await start_testing_server({
		adapter,
		daemon_name: 'testing_server_core_test',
		host: 'localhost',
		port: 0,
		build_app: async () => ({ app: new Hono(), close }),
		log
	});
	assert.ok(on_signal, 'the shutdown handler was registered');
	const handled = (on_signal as () => Promise<void>)().catch((error: unknown) => {
		if (!(error instanceof MockExitError)) throw error;
	});
	return { exits, exited: exited.promise, handled };
};

/** Fire the shutdown and return the exit codes once it has finished. */
const shut_down_with = async (close: BuiltTestingApp['close']): Promise<Array<number>> => {
	const { exits, handled } = await signal_shutdown(close);
	await handled;
	return exits;
};

describe('start_testing_server shutdown', () => {
	test('exits 0 when the close drained everything', async () => {
		assert.deepStrictEqual(await shut_down_with(async () => CLEAN), [0]);
	});

	test('exits 1 when the close gave up on a request', async () => {
		assert.deepStrictEqual(await shut_down_with(async () => ({ ...CLEAN, requests: 1 })), [1]);
	});

	test('exits 1 when the close gave up on an upkeep task', async () => {
		assert.deepStrictEqual(await shut_down_with(async () => ({ ...CLEAN, upkeep: 1 })), [1]);
	});

	test('exits 1 when the close threw', async () => {
		assert.deepStrictEqual(
			await shut_down_with(async () => {
				throw new Error('close failed');
			}),
			[1]
		);
	});

	test('a request the close gave up on does not hold the exit behind the listener drain', async () => {
		// the given-up request still holds its connection, so the listener's
		// drain never settles — the exit must not wait on it
		const never = create_deferred<void>();
		const { exits, exited } = await signal_shutdown(
			async () => ({ ...CLEAN, requests: 1 }),
			() => never.promise
		);
		const outcome = await Promise.race([
			exited.then(() => 'exited' as const),
			wait(2_000).then(() => 'blocked on the listener drain' as const)
		]);
		assert.strictEqual(outcome, 'exited');
		assert.deepStrictEqual(exits, [1]);
	});

	test('a clean close still waits for the listener drain before exiting 0', async () => {
		const drained = create_deferred<void>();
		const closed = create_deferred<void>();
		const { exits, handled } = await signal_shutdown(
			async () => {
				closed.resolve();
				return CLEAN;
			},
			() => drained.promise
		);
		await closed.promise;
		// let the shutdown run past the close to the drain
		await wait(0);
		assert.deepStrictEqual(exits, [], 'no exit before the listener drained');
		drained.resolve();
		await handled;
		assert.deepStrictEqual(exits, [0]);
	});
});
