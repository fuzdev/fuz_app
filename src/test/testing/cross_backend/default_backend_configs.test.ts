/**
 * Tests for `default_backend_configs.ts` — the daemon-token directory a
 * binary is pointed at, from the path the harness reads the token from.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import {
	make_default_rust_backend_config,
	rust_default_capabilities,
	to_daemon_token_dir
} from '#lib/testing/cross_backend/default_backend_configs.ts';
import { build_test_backend_paths } from '#lib/testing/cross_backend/build_test_backend_paths.ts';
import { in_process_capabilities } from '#lib/testing/cross_backend/capabilities.ts';

const make = (daemon_token_path?: string) =>
	make_default_rust_backend_config({
		name: 'daemon_token_dir_probe',
		port: 1,
		start_command: ['true'],
		database_url: 'postgres://localhost/x',
		capabilities: { ...in_process_capabilities, ...rust_default_capabilities },
		daemon_token_dir_env: 'PROBE_DAEMON_TOKEN_DIR',
		...(daemon_token_path === undefined ? {} : { bootstrap_overrides: { daemon_token_path } })
	});

describe('to_daemon_token_dir', () => {
	test('is the {dir} of a {dir}/run/daemon_token path', () => {
		assert.strictEqual(to_daemon_token_dir('/tmp/x/run/daemon_token'), '/tmp/x');
	});

	test('throws for a path in another layout', () => {
		for (const path of ['/tmp/x/daemon_token', '/tmp/x/run/token', '/tmp/x/var/daemon_token']) {
			assert.throws(() => to_daemon_token_dir(path), /\{dir\}\/run\/daemon_token/);
		}
	});
});

describe('daemon_token_dir_env', () => {
	test('names the directory that puts the token at the default path', () => {
		const config = make();
		const paths = build_test_backend_paths('daemon_token_dir_probe');
		assert.strictEqual(config.bootstrap.daemon_token_path, paths.daemon_token_path);
		assert.strictEqual(config.env.PROBE_DAEMON_TOKEN_DIR, paths.root);
	});

	test('follows an overridden daemon_token_path', () => {
		const config = make('/elsewhere/app/run/daemon_token');
		assert.strictEqual(config.env.PROBE_DAEMON_TOKEN_DIR, '/elsewhere/app');
	});

	test('throws on an override in another layout', () => {
		assert.throws(() => make('/elsewhere/token.json'));
	});
});
