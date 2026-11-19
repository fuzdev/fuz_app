/**
 * The credential conformance table exists twice: here
 * (`testing/cross_backend/credential_conformance.json`, read by the TS legs)
 * and in the Rust spine's `fuz_testing` crate, which embeds its copy with
 * `include_str!` for its own unit test. This holds the two byte-identical, so
 * a row added on one side fails here until it reaches the other.
 *
 * It reads the Cargo workspace the Rust stub is built from
 * (`resolve_rust_spine_stub_workspace_dir`), so it runs under the dual-spawn
 * `cross_backend_parity` project, whose setup builds from that checkout — and
 * fails, rather than skips, when the checkout or the copy is missing.
 *
 * @module
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test, assert } from 'vitest';

import { CREDENTIAL_CONFORMANCE_URL } from '#lib/testing/cross_backend/credential_conformance.ts';

import { resolve_rust_spine_stub_workspace_dir } from './global_setup_helpers.ts';

/** The Rust copy, relative to the Cargo workspace. */
const RUST_COPY_PATH = 'crates/fuz_testing/src/credential_conformance.json';

describe('credential conformance table copies', () => {
	test('the Rust spine embeds the table byte for byte', () => {
		const rust_copy = join(resolve_rust_spine_stub_workspace_dir(), RUST_COPY_PATH);
		assert.ok(existsSync(rust_copy), `the Rust copy of the table is missing: ${rust_copy}`);
		const ts_bytes = readFileSync(CREDENTIAL_CONFORMANCE_URL);
		const rust_bytes = readFileSync(rust_copy);
		assert.ok(
			ts_bytes.equals(rust_bytes),
			`credential_conformance.json differs from ${rust_copy} — copy the edited file over the other`
		);
	});
});
