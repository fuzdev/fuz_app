/**
 * Tests for `global_setup_helpers.ts` — the Postgres URL the Rust stub is
 * handed, as resolved from its env var.
 *
 * @module
 */

import { afterEach, beforeEach, describe, test, assert } from 'vitest';

import {
	RUST_SPINE_STUB_DATABASE_URL_ENV,
	RUST_SPINE_STUB_DEFAULT_DATABASE_URL
} from '#lib/testing/cross_backend/rust_spine_stub_backend_config.ts';

import { resolve_rust_spine_stub_database_url } from './global_setup_helpers.ts';

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
