/**
 * Tests for `create_file_bootstrap_token_store` — the token file's read asks
 * the secure read for a single link, and its burn removes the token.
 *
 * The burn is an unlink, which leaves an inode with a second hard link
 * readable under the other name, so the store refuses such a file where a
 * plain secure read (every other secret's) still reads it. On disk through
 * the Node runtime, and through the mock runtime's recorded link counts.
 * Twin of the Rust `bootstrap_token_store` unit tests.
 *
 * @module
 */

import { describe, assert, test, beforeEach, afterEach } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdtempSync,
	rmSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { create_file_bootstrap_token_store } from '#lib/auth/bootstrap_token_store.ts';
import { check_bootstrap_status } from '#lib/auth/bootstrap_routes.ts';
import { BOOTSTRAP_TOKEN_MIN_BYTES } from '#lib/auth/bootstrap_account.ts';
import { create_node_runtime } from '#lib/runtime/node.ts';
import { create_mock_runtime } from '#lib/runtime/mock.ts';

const TOKEN = `${'k'.repeat(BOOTSTRAP_TOKEN_MIN_BYTES)}\n`;

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe.runIf(process.platform !== 'win32')('the file store on disk', () => {
	let dir: string;
	let path: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'fuz-bootstrap-token-store-'));
		path = join(dir, 'bootstrap_token');
		writeFileSync(path, TOKEN);
		chmodSync(path, 0o600);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test('a token with a second hard link is refused, and reads once the other name is gone', async () => {
		const runtime = create_node_runtime();
		const store = create_file_bootstrap_token_store(runtime, path);
		const other = join(dir, 'other_name');
		linkSync(path, other);

		await assert_rejects(() => store.read_token(), /has 2 hard links/);
		// the plain secure read of the same file passes: the strictness is the store's
		assert.strictEqual(decode(await runtime.read_secure_file(path)), TOKEN);

		unlinkSync(other);
		assert.strictEqual(decode(await store.read_token()), TOKEN);
	});

	test('the burn of a single-link token removes it', async () => {
		const store = create_file_bootstrap_token_store(create_node_runtime(), path);
		assert.strictEqual(decode(await store.read_token()), TOKEN);
		assert.strictEqual(await store.burn_token(), 'burned');
		assert.isFalse(existsSync(path));
	});

	test('the boot check reads the window closed and names the link count', async () => {
		linkSync(path, join(dir, 'other_name'));
		const warnings: Array<string> = [];
		const log = new Logger('test', { level: 'off' });
		log.warn = (...args: Array<unknown>) => void warnings.push(args.join(' '));
		const status = await check_bootstrap_status(
			{ db: { query_one: async () => ({ bootstrapped: false }) as never }, log },
			{ token_store: create_file_bootstrap_token_store(create_node_runtime(), path) }
		);
		assert.deepStrictEqual(status, { available: false });
		assert.strictEqual(warnings.length, 1);
		assert.include(warnings[0], 'has 2 hard links');
	});
});

describe('the file store on the mock runtime', () => {
	test('a file has one link unless the mock records more', async () => {
		const runtime = create_mock_runtime();
		runtime.mock_fs.set('/token', TOKEN);
		runtime.mock_fs_modes.set('/token', 0o600);
		const store = create_file_bootstrap_token_store(runtime, '/token');
		assert.strictEqual(decode(await store.read_token()), TOKEN);

		runtime.mock_fs_links.set('/token', 2);
		await assert_rejects(() => store.read_token(), /has 2 hard links/);
		assert.strictEqual(decode(await runtime.read_secure_file('/token')), TOKEN);

		assert.strictEqual(await store.burn_token(), 'burned');
		assert.isFalse(runtime.mock_fs_links.has('/token'));
	});
});
