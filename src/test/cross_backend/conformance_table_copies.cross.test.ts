/**
 * The twin conformance tables each exist twice: here, beside the TS legs that
 * read them, and in the Rust spine's crates, which embed their copy with
 * `include_str!` for their own unit tests. This holds each pair
 * byte-identical, so a row added on one side fails here until it reaches the
 * other. The database invariant statement rides along: `db_invariants.sql` is
 * generated here (`db_invariants.gen.sql.ts`) and embedded by the Rust
 * spine's `_testing_db_invariants`, so an invariant added here fails until
 * the regenerated file is copied over. So do the SQL statements the two
 * resets share as constants (`TWIN_SQL_CONSTANTS`), each read out of the
 * Rust source as a plain string literal.
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
import { RESET_SESSION_CLOCK_STAMP_SQL } from '#lib/testing/cross_backend/testing_reset_actions.ts';

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
	},
	{
		name: 'db_invariants.sql',
		ts_url: new URL('../../lib/testing/db_invariants.sql', import.meta.url),
		rust_path: 'crates/fuz_testing/src/db_invariants.sql'
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

/** A SQL statement both spines hold as a constant: the TS value, and the Rust `const` naming it. */
interface TwinSqlConstant {
	readonly name: string;
	readonly ts_value: string;
	readonly rust_path: string;
}

const TWIN_SQL_CONSTANTS: ReadonlyArray<TwinSqlConstant> = [
	{
		name: 'RESET_SESSION_CLOCK_STAMP_SQL',
		ts_value: RESET_SESSION_CLOCK_STAMP_SQL,
		rust_path: 'crates/fuz_testing/src/testing_reset.rs'
	}
];

/**
 * The value of `const <name>: &str = "...";` in Rust source — a plain string
 * literal with no escapes, which is all a shared statement needs; anything
 * else is refused rather than read wrong.
 */
const read_rust_str_const = (source: string, name: string): string | null => {
	const match = new RegExp(`const ${name}: &str =\\s*"([^"\\\\]*)";`).exec(source);
	return match ? match[1]! : null;
};

describe('shared SQL constants', () => {
	test.each(TWIN_SQL_CONSTANTS)(
		'the Rust spine holds $name byte for byte',
		({ name, ts_value, rust_path }) => {
			const rust_file = join(resolve_rust_spine_stub_workspace_dir(), rust_path);
			assert.ok(existsSync(rust_file), `the Rust source of ${name} is missing: ${rust_file}`);
			const rust_value = read_rust_str_const(readFileSync(rust_file, 'utf8'), name);
			assert.ok(rust_value !== null, `no plain-literal \`const ${name}: &str\` in ${rust_file}`);
			assert.strictEqual(rust_value, ts_value, `${name} differs from ${rust_file}`);
		}
	);
});
