/**
 * Tests for `create_daemon_token_file` — the static daemon token a test
 * binary writes for the cross-process harness: written once at mode `0600` in
 * the reader's `{"token"}` shape, matching the returned state, and removed by
 * `stop`, which is safe to call twice, counts a file already gone as removed,
 * and rejects on any other removal failure.
 *
 * @module
 */

import { afterEach, assert, beforeEach, test } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { create_daemon_token_file } from '#lib/testing/daemon_token_file.ts';
import { create_node_runtime } from '#lib/runtime/node.ts';
import { create_stub_db } from '#lib/testing/stubs.ts';

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'fuz_app_daemon_token_file_'));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const exists = (path: string): Promise<boolean> =>
	stat(path).then(
		() => true,
		() => false
	);

test('writes the token at mode 0600 under a created directory, matching the state', async () => {
	const token_path = join(dir, 'run', 'daemon_token');
	const file = await create_daemon_token_file(
		create_node_runtime(),
		{ db: create_stub_db() },
		token_path
	);
	const content = await readFile(token_path, 'utf8');
	assert.deepEqual(JSON.parse(content), { token: file.state.current_token });
	assert.strictEqual((await stat(token_path)).mode & 0o777, 0o600);
	assert.isNull(file.state.previous_token);
	// no keeper in the stub database
	assert.isNull(file.state.keeper_account_id);
	await file.stop();
});

test('stop removes the file, and a second stop does nothing more', async () => {
	const token_path = join(dir, 'daemon_token');
	const file = await create_daemon_token_file(
		create_node_runtime(),
		{ db: create_stub_db() },
		token_path
	);
	assert.isTrue(await exists(token_path));
	await Promise.all([file.stop(), file.stop()]);
	assert.isFalse(await exists(token_path));
	await file.stop();
	assert.isFalse(await exists(token_path));
});

test('each file gets its own token', async () => {
	const runtime = create_node_runtime();
	const a = await create_daemon_token_file(runtime, { db: create_stub_db() }, join(dir, 'a'));
	const b = await create_daemon_token_file(runtime, { db: create_stub_db() }, join(dir, 'b'));
	assert.notStrictEqual(a.state.current_token, b.state.current_token);
	await Promise.all([a.stop(), b.stop()]);
});

test('stop counts a file already gone as removed', async () => {
	const token_path = join(dir, 'daemon_token');
	const file = await create_daemon_token_file(
		create_node_runtime(),
		{ db: create_stub_db() },
		token_path
	);
	await rm(token_path);
	await file.stop();
	assert.isFalse(await exists(token_path));
});

test('stop rejects on a removal failure other than not-found', async () => {
	const runtime = create_node_runtime();
	const file = await create_daemon_token_file(
		{
			...runtime,
			remove: async () => {
				throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
			}
		},
		{ db: create_stub_db() },
		join(dir, 'daemon_token')
	);
	const error = await assert_rejects(() => file.stop());
	assert.include(error.message, 'EACCES');
});
