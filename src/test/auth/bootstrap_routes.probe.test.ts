/**
 * Tests for `check_bootstrap_status` — the boot-time availability probe.
 *
 * The probe reads through the same `read_secure_file` the request-time read
 * uses, so "bootstrap is available" can never be laxer than the read it
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
} from '$lib/auth/bootstrap_routes.ts';

const log = new Logger('test', { level: 'off' });

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
				read_secure_file: async () => new TextEncoder().encode('token\n'),
				db: stub_db_with_lock(false),
				log
			},
			{ token_path: '/token' }
		);
		assert.deepStrictEqual(status, { available: true, token_path: '/token' });
	});

	test('an already-flipped lock reports unavailable even with a readable token', async () => {
		const status = await check_bootstrap_status(
			{
				read_secure_file: async () => new TextEncoder().encode('token\n'),
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
