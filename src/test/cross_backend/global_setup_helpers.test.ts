/**
 * Tests for `global_setup_helpers.ts` — the Postgres URL the Rust stub is
 * handed, as resolved from its env var, the built binary's path, and the rebuild-skip switch.
 *
 * @module
 */

import { afterEach, beforeEach, describe, test, assert } from 'vitest';

import {
	RUST_SPINE_STUB_DATABASE_URL_ENV,
	RUST_SPINE_STUB_DEFAULT_DATABASE_URL
} from '#lib/testing/cross_backend/rust_spine_stub_backend_config.ts';

import {
	is_no_rebuild_requested,
	resolve_rust_spine_stub_database_url,
	to_rust_spine_stub_bin_path
} from './global_setup_helpers.ts';

describe('resolve_rust_spine_stub_database_url', () => {
	let saved: string | undefined;

	beforeEach(() => {
		saved = process.env[RUST_SPINE_STUB_DATABASE_URL_ENV];
	});

	afterEach(() => {
		if (saved === undefined) delete process.env[RUST_SPINE_STUB_DATABASE_URL_ENV];
		else process.env[RUST_SPINE_STUB_DATABASE_URL_ENV] = saved;
	});

	test('falls back to the default when the variable is unset or empty', () => {
		delete process.env[RUST_SPINE_STUB_DATABASE_URL_ENV];
		assert.strictEqual(
			resolve_rust_spine_stub_database_url(),
			RUST_SPINE_STUB_DEFAULT_DATABASE_URL
		);
		process.env[RUST_SPINE_STUB_DATABASE_URL_ENV] = '';
		assert.strictEqual(
			resolve_rust_spine_stub_database_url(),
			RUST_SPINE_STUB_DEFAULT_DATABASE_URL
		);
	});

	test('takes a postgres:// or postgresql:// URL as given', () => {
		for (const url of [
			'postgres://user@db.example:5433/some_db',
			'postgresql://user:secret@db.example/some_db?sslmode=require'
		]) {
			process.env[RUST_SPINE_STUB_DATABASE_URL_ENV] = url;
			assert.strictEqual(resolve_rust_spine_stub_database_url(), url);
		}
	});

	test('refuses a value that is not a Postgres URL, without echoing it', () => {
		for (const value of [
			// scheme-less: `URL` reads `localhost:` as the protocol
			'localhost:5432/some_db',
			'db.example:5432/some_db',
			'http://db.example:5432/some_db',
			'memory://',
			'some_db',
			'postgres//user:hunter2@db.example/some_db'
		]) {
			process.env[RUST_SPINE_STUB_DATABASE_URL_ENV] = value;
			const error = (() => {
				try {
					resolve_rust_spine_stub_database_url();
					return null;
				} catch (err) {
					return err;
				}
			})();
			assert.ok(error instanceof Error, `${value} must be refused`);
			assert.ok(error.message.includes(RUST_SPINE_STUB_DATABASE_URL_ENV), 'names the variable');
			assert.ok(error.message.includes('postgres://'), 'says what form is expected');
			assert.ok(!error.message.includes(value), 'does not echo the value');
		}
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

describe('to_rust_spine_stub_bin_path', () => {
	test('puts the binary under the target directory cargo reports', () => {
		const metadata = JSON.stringify({
			packages: [],
			workspace_root: '/work/fuz',
			target_directory: '/elsewhere/cargo-target'
		});
		assert.strictEqual(
			to_rust_spine_stub_bin_path(metadata, 'testing_spine_stub'),
			'/elsewhere/cargo-target/cross-test/testing_spine_stub'
		);
	});

	test('throws when the output names no target directory', () => {
		for (const metadata of ['{}', '{"target_directory": ""}', '{"target_directory": 7}']) {
			assert.throws(() => to_rust_spine_stub_bin_path(metadata, 'testing_spine_stub'));
		}
	});
});
