/**
 * Tests for `check_bootstrap_status` — the boot-time availability probe.
 *
 * The probe reads through the same `read_bootstrap_token` the request-time
 * read uses (the store's secure read plus the minimum token length), so
 * "bootstrap is available" can never be laxer than the read it gates. It
 * reads the lock first, and reports each state at its level: a missing lock
 * row an error, a bootstrapped server with no token file info, one with a
 * token file still present a warning naming it, an open window with an
 * unreadable file a warning with the reason. Twin of the Rust spine's
 * `is_bootstrap_available`.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import {
	check_bootstrap_status,
	type CheckBootstrapStatusDeps
} from '#lib/auth/bootstrap_routes.ts';
import { BOOTSTRAP_TOKEN_MIN_BYTES } from '#lib/auth/bootstrap_account.ts';
import type { BootstrapTokenStore } from '#lib/auth/bootstrap_token_store.ts';

/** A token at exactly the minimum length. */
const VALID_TOKEN = 'k'.repeat(BOOTSTRAP_TOKEN_MIN_BYTES);

const stub_db_with_lock = (bootstrapped: boolean | null): CheckBootstrapStatusDeps['db'] => ({
	query_one: async () => (bootstrapped === null ? undefined : { bootstrapped }) as never
});

/** A store reading `content`, or refusing with `content` as the reason when it is an `Error`. */
const store = (content: string | Error, reads?: { count: number }): BootstrapTokenStore => ({
	path: '/token',
	read_token: async () => {
		if (reads) reads.count++;
		if (content instanceof Error) throw content;
		return new TextEncoder().encode(content);
	},
	burn_token: async () => {
		throw new Error('the boot probe never burns');
	}
});

/** A logger recording each level's lines. */
const recording_log = (): {
	log: Logger;
	lines: { error: Array<string>; warn: Array<string>; info: Array<string> };
} => {
	const lines = {
		error: [] as Array<string>,
		warn: [] as Array<string>,
		info: [] as Array<string>
	};
	const log = new Logger('test', { level: 'off' });
	log.error = (...args: Array<unknown>) => void lines.error.push(args.join(' '));
	log.warn = (...args: Array<unknown>) => void lines.warn.push(args.join(' '));
	log.info = (...args: Array<unknown>) => void lines.info.push(args.join(' '));
	return { log, lines };
};

describe('check_bootstrap_status', () => {
	test('a refused secure read reports unavailable with a warning — the probe is exactly as strict as the read', async () => {
		const { log, lines } = recording_log();
		const status = await check_bootstrap_status(
			{ db: stub_db_with_lock(false), log },
			{ token_store: store(new Error('insecure permissions on /token: 644 (expected 0600)')) }
		);
		assert.deepStrictEqual(status, { available: false });
		assert.strictEqual(lines.warn.length, 1);
		assert.include(lines.warn[0], 'insecure permissions');
		assert.deepEqual(lines.error, []);
	});

	test('a readable token with an open lock reports available', async () => {
		const { log, lines } = recording_log();
		const status = await check_bootstrap_status(
			{ db: stub_db_with_lock(false), log },
			{ token_store: store(`${VALID_TOKEN}\n`) }
		);
		assert.deepStrictEqual(status, { available: true });
		assert.deepEqual(lines.warn, []);
	});

	test('a token under the minimum length reports unavailable and logs an error naming the file', async () => {
		// empty, a lone newline, one byte short (the trailing LF doesn't count)
		for (const content of ['', '\n', `${'k'.repeat(BOOTSTRAP_TOKEN_MIN_BYTES - 1)}\n`]) {
			const { log, lines } = recording_log();
			const status = await check_bootstrap_status(
				{ db: stub_db_with_lock(false), log },
				{ token_store: store(content) }
			);
			assert.deepStrictEqual(status, { available: false }, content);
			assert.strictEqual(lines.error.length, 1, content);
			assert.include(lines.error[0], '/token');
			assert.strictEqual(lines.warn.length, 1, content);
		}
	});

	test('a bootstrapped server with no token file reports unavailable at info', async () => {
		const { log, lines } = recording_log();
		const status = await check_bootstrap_status(
			{ db: stub_db_with_lock(true), log },
			{ token_store: store(new Error('ENOENT: /token')) }
		);
		assert.deepStrictEqual(status, { available: false });
		assert.deepEqual(lines.warn, []);
		assert.deepEqual(lines.error, []);
		assert.strictEqual(lines.info.length, 1);
	});

	test('a bootstrapped server with a token file still present warns naming it', async () => {
		const { log, lines } = recording_log();
		const status = await check_bootstrap_status(
			{ db: stub_db_with_lock(true), log },
			{ token_store: store(`${VALID_TOKEN}\n`) }
		);
		assert.deepStrictEqual(status, { available: false });
		assert.strictEqual(lines.warn.length, 1);
		assert.include(lines.warn[0], '/token');
		assert.include(lines.warn[0], 'delete it');
	});

	test('a missing lock row reports unavailable with an error, even with a good token', async () => {
		const { log, lines } = recording_log();
		const status = await check_bootstrap_status(
			{ db: stub_db_with_lock(null), log },
			{ token_store: store(`${VALID_TOKEN}\n`) }
		);
		assert.deepStrictEqual(status, { available: false });
		assert.strictEqual(lines.error.length, 1);
		assert.include(lines.error[0], 'bootstrap_lock');
	});

	test('no token store reports unavailable without touching the database', async () => {
		const { log } = recording_log();
		const status = await check_bootstrap_status(
			{
				db: {
					query_one: async () => {
						throw new Error('the probe read the lock with no store');
					}
				},
				log
			},
			{ token_store: null }
		);
		assert.deepStrictEqual(status, { available: false });
	});
});
