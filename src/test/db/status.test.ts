/**
 * Tests for `format_db_status`, the operator report body, and `display_db_url`.
 *
 * The connected layout is byte-identical with the Rust twin's
 * `fuz_db::format_db_status`: `FIXTURE_STATUS` and `FIXTURE_REPORT` mirror the
 * fixture its unit tests pin, so a layout change on either side fails here or
 * there until both move together.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';

import {
	format_db_status,
	display_db_url,
	type DbStatus,
	type MigrationStatus
} from '$lib/db/status.ts';

const ns_status = (
	namespace: string,
	applied_names: Array<string>,
	pending_names: Array<string>,
	divergence?: MigrationStatus['divergence']
): MigrationStatus => ({
	namespace,
	applied_names,
	pending_names,
	up_to_date: pending_names.length === 0 && divergence === undefined,
	...(divergence ? { divergence } : {})
});

/** One namespace in each state the report renders. */
const FIXTURE_STATUS: DbStatus = {
	connected: true,
	table_count: 2,
	tables: [
		{ name: 'account', row_count: 3 },
		{ name: 'schema_version', row_count: 7 }
	],
	migrations: [
		ns_status('fuz_auth', ['full_auth_schema'], []),
		ns_status('app_notes', ['create_notes'], ['add_note_tags', 'add_note_index']),
		ns_status('fuz_cell', ['cell_v0'], [], {
			kind: 'name_mismatch',
			position: 0,
			applied: 'cell_v0',
			expected: 'full_cell_schema'
		}),
		ns_status('app_fresh', [], ['create_fresh']),
		ns_status('app_older', ['m0', 'm1', 'm2_unknown'], [], {
			kind: 'binary_older',
			applied: 3,
			declared: 2
		})
	]
};

/** The expected report for `FIXTURE_STATUS` — shared verbatim with the Rust twin's test. */
const FIXTURE_REPORT = `  tables: 2
    account         3 rows
    schema_version  7 rows

  migrations:
    fuz_auth   up-to-date   1/1  latest: full_auth_schema
    app_notes  PENDING 2    1/3  latest: create_notes
                 pending: add_note_tags, add_note_index
    fuz_cell   DIVERGED     1/1  latest: cell_v0
                 diverged: position 0: database has \`cell_v0\`, code has \`full_cell_schema\`
    app_fresh  PENDING 1    0/1  latest: (none)
                 pending: create_fresh
    app_older  DIVERGED     3/2  latest: m2_unknown
                 diverged: database has 3 applied but code declares 2 (binary older than database)
`;

describe('format_db_status', () => {
	test('renders every namespace state, byte-identical with the Rust twin', () => {
		assert.strictEqual(format_db_status(FIXTURE_STATUS), FIXTURE_REPORT);
	});

	test('binary older: the denominator is the declared count, not applied + pending', () => {
		const out = format_db_status({
			connected: true,
			table_count: 0,
			tables: [],
			migrations: [
				ns_status('older', ['m0', 'm1', 'm2'], [], {
					kind: 'binary_older',
					applied: 3,
					declared: 2
				})
			]
		});
		assert.ok(out.includes('DIVERGED     3/2  latest: m2\n'), out);
	});

	test('no namespaces → still prints the migrations header', () => {
		const out = format_db_status({ connected: true, table_count: 0, tables: [], migrations: [] });
		assert.strictEqual(out, '  tables: 0\n\n  migrations:\n');
	});

	test('not connected → a single connection: FAILED line with the error', () => {
		const status: DbStatus = {
			connected: false,
			error: 'connection refused',
			table_count: 0,
			tables: [],
			migrations: []
		};
		assert.strictEqual(format_db_status(status), '  connection: FAILED (connection refused)\n');
		assert.strictEqual(format_db_status({ ...status, error: undefined }), '  connection: FAILED\n');
	});
});

/**
 * Input → exact rendering for the shapes both drivers read alike — the same
 * table the Rust twin's `display_db_url` test carries.
 */
const SHARED_DISPLAY_CASES: Array<[string, string]> = [
	['postgres://user:secret@db.example.com:5432/app', 'postgres://user@db.example.com:5432/app'],
	['postgres://localhost/visiones', 'postgres://localhost:5432/visiones'],
	['postgresql://user@localhost/app', 'postgres://user@localhost:5432/app'],
	['postgres://u:pw@[::1]:6543/db', 'postgres://u@[::1]:6543/db'],
	['postgres://[0:0::1]/db', 'postgres://[::1]:5432/db'],
	['postgres://127.0.0.1/db', 'postgres://127.0.0.1:5432/db'],
	['postgres://U%40x@HOST/D%20b', 'postgres://U%40x@HOST:5432/D%20b'],
	['postgres://%2Fvar%2Frun%2Fpg/db', 'postgres://%2Fvar%2Frun%2Fpg:5432/db'],
	['postgres://h/', 'postgres://h:5432'],
	['postgres://h:5432/db?sslmode=disable&application_name=x', 'postgres://h:5432/db'],
	// a query `user=` replaces the URL's in both drivers
	['postgres://u@h/db?user=admin', 'postgres://admin@h:5432/db'],
	// control characters, escape sequences, and bidi overrides stay encoded
	['postgres://h/d%0Ab', 'postgres://h:5432/d%0Ab'],
	['postgres://h/%1B%5B31mx', 'postgres://h:5432/%1B%5B31mx'],
	['postgres://%E2%80%AEu@h/db', 'postgres://%E2%80%AEu@h:5432/db'],
	// the placeholder: no host, a host that isn't a hostname, a user a misparse
	// could have produced, a malformed escape, no parse at all
	['postgres:///db', '(not a URL; hidden)'],
	['postgres://h%20x/db', '(not a URL; hidden)'],
	['postgres://h%3Ax/db', '(not a URL; hidden)'],
	['postgres://a%3Db@h/db', '(not a URL; hidden)'],
	['postgres://u%ZZ@h/db', '(not a URL; hidden)'],
	['postgres://h/db?user=u%ZZ', '(not a URL; hidden)'],
	['garbage', '(not a URL; hidden)']
];

/**
 * Inputs carrying the secret `s3cr3t` where a string-level redactor, or a
 * misparse, leaks it: an unencoded `/`, `?`, or `@` in the password
 * (tokio-postgres ends the credentials at the first `@`), a query secret ahead
 * of a later `@`, and password query parameters, percent-encoded keys included
 * (both drivers decode them). The same list as the Rust twin's test.
 */
const LEAK_CASES = [
	'postgres://u:s3cr3t/b@h/db',
	'postgres://u:s3cr3t?b@h',
	'postgres://u:a/s3cr3t?c@h',
	'postgres://u:s3cr3t@x@h/db',
	'postgres://u:p@s3cr3t@h/db',
	'postgres://h?password=s3cr3t:x@b',
	'postgres://h?sslpassword=@b&sslpassword=s3cr3t',
	'postgres://u@h/db?password=s3cr3t',
	'postgres://u@h/db?pass%77ord=s3cr3t',
	'postgres://u@h/db?sslpassword=s3cr3t'
];

describe('display_db_url', () => {
	test('renders the shared cases, byte-identical with the Rust twin', () => {
		for (const [input, expected] of SHARED_DISPLAY_CASES) {
			assert.strictEqual(display_db_url(input), expected, input);
		}
	});

	test('never prints the password', () => {
		const leaks = LEAK_CASES.flatMap((input) => {
			const shown = display_db_url(input);
			return shown.includes('s3cr3t') ? [`${input} -> ${shown}`] : [];
		});
		assert.deepStrictEqual(leaks, []);
	});

	test('names the server node-postgres dials: query host and port override the URL', () => {
		assert.strictEqual(
			display_db_url('postgres://u@h/db?host=prod.example.com&port=6000'),
			'postgres://u@prod.example.com:6000/db'
		);
		assert.strictEqual(
			display_db_url('postgres://h/db?host=/run/pg'),
			'postgres://%2Frun%2Fpg:5432/db'
		);
		assert.strictEqual(display_db_url('postgres://h/db?port=x'), '(not a URL; hidden)');
		assert.strictEqual(display_db_url('postgres://h/db?host=a%20b'), '(not a URL; hidden)');
	});

	test('`new URL` rejects what only tokio-postgres parses → the placeholder', () => {
		// key=value conninfo, host lists, an unencoded `/` or `?` in the password
		for (const input of [
			'host=/var/run/pg user=u password=s3cr3t dbname=d port=5433',
			'postgres://h1:5432,h2:5433/db',
			'postgres://h1,h2/db',
			'postgres://u:a/b@h/db',
			'postgres://u:a?b@h'
		]) {
			assert.strictEqual(display_db_url(input), '(not a URL; hidden)', input);
		}
		// an unencoded `@` in the password splits at the last `@` (tokio-postgres
		// splits at the first and the Rust twin prints the placeholder)
		assert.strictEqual(display_db_url('postgres://u:p@ss@h/db'), 'postgres://u@h:5432/db');
		// node-postgres decodes the database name with `decodeURI`, so a
		// reserved-character escape stays literal
		assert.strictEqual(display_db_url('postgres://h/a%2Fb'), 'postgres://h:5432/a%252Fb');
	});

	test('PGlite URLs print as scheme, host, and path', () => {
		assert.strictEqual(display_db_url('file://./.db/pglite'), 'file://./.db/pglite');
		assert.strictEqual(display_db_url('memory://'), 'memory://');
		assert.strictEqual(display_db_url('file://h/x?k=v#f'), 'file://h/x');
	});
});
