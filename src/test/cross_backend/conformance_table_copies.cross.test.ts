/**
 * The twin conformance tables each exist twice: here, beside the TS legs that
 * read them, and in the Rust spine's crates, which embed their copy with
 * `include_str!` for their own unit tests. This holds each pair
 * byte-identical, so a row added on one side fails here until it reaches the
 * other.
 *
 * It reads the Cargo workspace the Rust stub is built from
 * (`resolve_rust_spine_stub_workspace_dir`), so it runs under the dual-spawn
 * `cross_backend_parity` project, whose setup builds from that checkout — and
 * fails, rather than skips, when the checkout or a copy is missing.
 *
 * @module
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test, assert } from 'vitest';

import { CREDENTIAL_CONFORMANCE_URL } from '#lib/testing/cross_backend/credential_conformance.ts';
import { REQUEST_HEADER_CONFORMANCE_URL } from '#lib/testing/cross_backend/request_header_conformance.ts';
import { REQUEST_TARGET_CONFORMANCE_URL } from '#lib/testing/cross_backend/request_target_conformance.ts';

import { resolve_rust_spine_stub_workspace_dir } from './global_setup_helpers.ts';

/** A table with a Rust twin: the TS copy, and the Rust copy relative to the Cargo workspace. */
interface TwinTable {
	readonly name: string;
	readonly ts_url: URL;
	readonly rust_path: string;
}

const TWIN_TABLES: ReadonlyArray<TwinTable> = [
	{
		name: 'credential_conformance.json',
		ts_url: CREDENTIAL_CONFORMANCE_URL,
		rust_path: 'crates/fuz_testing/src/credential_conformance.json'
	},
	{
		name: 'request_header_conformance.json',
		ts_url: REQUEST_HEADER_CONFORMANCE_URL,
		rust_path: 'crates/fuz_http/src/request_header_conformance.json'
	},
	{
		name: 'request_target_conformance.json',
		ts_url: REQUEST_TARGET_CONFORMANCE_URL,
		rust_path: 'crates/fuz_http/src/request_target_conformance.json'
	}
];

describe('conformance table copies', () => {
	test.each(TWIN_TABLES)(
		'the Rust spine embeds $name byte for byte',
		({ name, ts_url, rust_path }) => {
			const rust_copy = join(resolve_rust_spine_stub_workspace_dir(), rust_path);
			assert.ok(existsSync(rust_copy), `the Rust copy of ${name} is missing: ${rust_copy}`);
			assert.ok(
				readFileSync(ts_url).equals(readFileSync(rust_copy)),
				`${name} differs from ${rust_copy} — copy the edited file over the other`
			);
		}
	);
});
