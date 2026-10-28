/**
 * Tests for `default_backend_configs.ts` — the daemon-token directory a
 * binary is pointed at, from the path the harness reads the token from, and
 * the repo-namespaced default tmpdir.
 *
 * @module
 */

import { describe, test, assert, vi, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	make_default_rust_backend_config,
	make_default_ts_backend_config,
	rust_default_capabilities,
	to_daemon_token_dir,
	ts_default_capabilities
} from '#lib/testing/cross_backend/default_backend_configs.ts';
import {
	build_test_backend_paths,
	default_test_backend_paths
} from '#lib/testing/cross_backend/build_test_backend_paths.ts';
import {
	in_process_capabilities,
	type FamilyDefaultCapabilities
} from '#lib/testing/cross_backend/capabilities.ts';

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

describe('default tmpdir', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** The default-path TS and Rust configs for backend `name`, built from `cwd`. */
	const tokens_from = (cwd: string, name: string): Array<string> => {
		vi.spyOn(process, 'cwd').mockReturnValue(cwd);
		const shared = { name, port: 1, start_command: ['true'] };
		return [
			make_default_rust_backend_config({
				...shared,
				database_url: 'postgres://localhost/x',
				capabilities: { ...in_process_capabilities, ...rust_default_capabilities }
			}),
			make_default_ts_backend_config({
				...shared,
				capabilities: { ...in_process_capabilities, ...ts_default_capabilities }
			})
		].map((config) => config.bootstrap.token_path);
	};

	test('is namespaced by the running repo, so one backend name in two repos never collides', () => {
		const [cord_rust, cord_ts] = tokens_from('/home/dev/cord', 'rust');
		const [dotted_rust, dotted_ts] = tokens_from('/home/dev/example.org', 'rust');
		assert.strictEqual(cord_rust, join(tmpdir(), 'cord_rust', 'bootstrap_token'));
		assert.strictEqual(cord_ts, cord_rust);
		assert.strictEqual(dotted_rust, join(tmpdir(), 'example.org_rust', 'bootstrap_token'));
		assert.strictEqual(dotted_ts, dotted_rust);
	});

	test('an explicit prefix is taken as given', () => {
		vi.spyOn(process, 'cwd').mockReturnValue('/home/dev/fuz_forge');
		assert.strictEqual(
			build_test_backend_paths('fuz_forge_cross_rust').root,
			join(tmpdir(), 'fuz_forge_cross_rust')
		);
	});
});

describe('daemon_token_dir_env', () => {
	test('names the directory that puts the token at the default path', () => {
		const config = make();
		const paths = default_test_backend_paths('daemon_token_dir_probe');
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

describe('testing_backdoors has no family default', () => {
	/** Every mount flag, stated, as a config spreading a family default must. */
	const mount_flags = {
		ws: false,
		sse: false,
		cell_crud: false,
		cell_relations: false,
		cell_gated_create: false,
		fact_serving: false,
		fact_serving_admin_hash: false,
		ready: false,
		peer_request: false,
		ws_account_actions: false,
		ws_role_gated: false
	} as const;
	const options = {
		name: 'backdoor_declaration_probe',
		port: 1,
		start_command: ['true'],
		database_url: 'postgres://localhost/x'
	};

	test('a config states it, and only known backdoors', () => {
		const config = make_default_rust_backend_config({
			...options,
			capabilities: {
				...rust_default_capabilities,
				...mount_flags,
				testing_backdoors: ['_testing_reset', '_testing_drain_effects']
			}
		});
		assert.deepStrictEqual(config.capabilities.testing_backdoors, [
			'_testing_reset',
			'_testing_drain_effects'
		]);
		make_default_rust_backend_config({
			...options,
			// @ts-expect-error - a config leaving the backdoor list out fails typecheck
			capabilities: { ...rust_default_capabilities, ...mount_flags }
		});
		make_default_rust_backend_config({
			...options,
			capabilities: {
				...rust_default_capabilities,
				...mount_flags,
				// @ts-expect-error - a consumer seam is not a known backdoor
				testing_backdoors: ['_testing_app_invite_expire']
			}
		});
	});

	test('the family defaults carry none', () => {
		assert.ok(!('testing_backdoors' in rust_default_capabilities));
		assert.ok(!('testing_backdoors' in ts_default_capabilities));
		const family: FamilyDefaultCapabilities = {
			...ts_default_capabilities,
			// @ts-expect-error - a family default can't carry the backdoor list
			testing_backdoors: []
		};
		assert.ok(family);
	});
});
