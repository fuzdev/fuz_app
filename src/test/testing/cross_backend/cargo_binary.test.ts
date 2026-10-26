/**
 * Tests for `cargo_binary.ts` — the built binary's path, read from
 * `cargo metadata` output, and the rebuild-skip switch.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import {
	is_no_rebuild_requested,
	to_cargo_binary_path,
	to_cargo_profile_dir
} from '#lib/testing/cross_backend/cargo_binary.ts';

describe('to_cargo_binary_path', () => {
	const metadata = JSON.stringify({
		packages: [],
		workspace_root: '/work/fuz',
		target_directory: '/elsewhere/cargo-target'
	});

	test('puts the binary under the target directory cargo reports, in its profile directory', () => {
		assert.strictEqual(
			to_cargo_binary_path(metadata, 'testing_spine_stub', 'cross-test'),
			'/elsewhere/cargo-target/cross-test/testing_spine_stub'
		);
		assert.strictEqual(
			to_cargo_binary_path(metadata, 'testing_zzzd', 'dev'),
			'/elsewhere/cargo-target/debug/testing_zzzd'
		);
		assert.strictEqual(
			to_cargo_binary_path(metadata, 'testing_zzzd', 'release'),
			'/elsewhere/cargo-target/release/testing_zzzd'
		);
	});

	test('throws when the output names no target directory', () => {
		for (const bad of ['{}', '{"target_directory": ""}', '{"target_directory": 7}']) {
			assert.throws(() => to_cargo_binary_path(bad, 'testing_spine_stub', 'dev'));
		}
	});

	test('the dev profile builds into debug, every other profile into its own name', () => {
		assert.strictEqual(to_cargo_profile_dir('dev'), 'debug');
		assert.strictEqual(to_cargo_profile_dir('release'), 'release');
		assert.strictEqual(to_cargo_profile_dir('cross-test'), 'cross-test');
	});
});

describe('is_no_rebuild_requested', () => {
	test('skips the rebuild only for an explicit 1 or true', () => {
		for (const value of ['1', 'true', 'TRUE', 'True']) {
			assert.ok(is_no_rebuild_requested(value), `${value} skips the rebuild`);
		}
	});

	test('rebuilds when unset or set to anything else', () => {
		for (const value of [undefined, '', '0', 'false', 'no', ' 1', 'yes']) {
			assert.ok(!is_no_rebuild_requested(value), `${String(value)} rebuilds`);
		}
	});
});
