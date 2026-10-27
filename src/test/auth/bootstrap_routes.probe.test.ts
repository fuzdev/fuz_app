/**
 * Tests for `check_bootstrap_status` — the boot-time availability probe.
 *
 * The probe reads through the same `read_bootstrap_token` the request-time
 * read uses (the secure read plus the minimum token length), so "bootstrap is available" can never be laxer than the read it
 * gates (a `stat`-only probe reported green for a token file the hardened
 * read would refuse — a 0644 hand-placed token advertised a window the POST
 * could never walk through). Twin of the Rust spine's
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

const log = new Logger('test', { level: 'off' });

/** A token at exactly the minimum length. */
const VALID_TOKEN = 'k'.repeat(BOOTSTRAP_TOKEN_MIN_BYTES);

const stub_db_with_lock = (bootstrapped: boolean): CheckBootstrapStatusDeps['db'] => ({
	query_one: async () => ({ bootstrapped }) as never
});

describe('check_bootstrap_status', () => {
	test('a refused secure read reports unavailable — the probe is exactly as strict as the read', async () => {
		const status = await check_bootstrap_status(
			{
				read_secure_file: async () => {
					throw new Error('insecure permissions on /token: 644 (expected 0600)');
				},
				db: stub_db_with_lock(false),
				log
			},
			{ token_path: '/token' }
		);
		assert.deepStrictEqual(status, { available: false, token_path: '/token' });
	});

	test('a readable token with an open lock reports available', async () => {
		const status = await check_bootstrap_status(
			{
				read_secure_file: async () => new TextEncoder().encode(`${VALID_TOKEN}\n`),
				db: stub_db_with_lock(false),
				log
			},
			{ token_path: '/token' }
		);
		assert.deepStrictEqual(status, { available: true, token_path: '/token' });
	});

	test('a token under the minimum length reports unavailable and logs an error naming the file', async () => {
		// empty, a lone newline, one byte short (the trailing LF doesn't count)
		for (const content of ['', '\n', `${'k'.repeat(BOOTSTRAP_TOKEN_MIN_BYTES - 1)}\n`]) {
			const errors: Array<string> = [];
			const loud_log = new Logger('test', { level: 'off' });
			loud_log.error = (...args: Array<unknown>) => {
				errors.push(args.join(' '));
			};
			const status = await check_bootstrap_status(
				{
					read_secure_file: async () => new TextEncoder().encode(content),
					db: stub_db_with_lock(false),
					log: loud_log
				},
				{ token_path: '/token' }
			);
			assert.deepStrictEqual(status, { available: false, token_path: '/token' }, content);
			assert.strictEqual(errors.length, 1, content);
			assert.include(errors[0], '/token');
		}
	});

	test('an already-flipped lock reports unavailable even with a readable token', async () => {
		const status = await check_bootstrap_status(
			{
				read_secure_file: async () => new TextEncoder().encode(`${VALID_TOKEN}\n`),
				db: stub_db_with_lock(true),
				log
			},
			{ token_path: '/token' }
		);
		assert.deepStrictEqual(status, { available: false, token_path: '/token' });
	});

	test('a null token_path reports unavailable without touching the filesystem', async () => {
		let read = false;
		const status = await check_bootstrap_status(
			{
				read_secure_file: async () => {
					read = true;
					return new Uint8Array();
				},
				db: stub_db_with_lock(false),
				log
			},
			{ token_path: null }
		);
		assert.deepStrictEqual(status, { available: false, token_path: null });
		assert.isFalse(read);
	});
});
