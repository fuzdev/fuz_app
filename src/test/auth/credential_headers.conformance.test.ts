/**
 * The credential conformance table, run against the TS twin directly: every
 * row of `testing/cross_backend/credential_conformance.json` through the
 * `_testing_credential_read` action's input schema and
 * `run_testing_credential_read` — the function the action serves, over the
 * readers the auth middleware legs call (`read_session_cookie_value`,
 * `read_bearer_token`, `read_daemon_token`).
 * The cross-process legs (`cross_backend/spine_suites.cross.test.ts`) send
 * the same rows to every backend, through the action and as real requests.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { parse } from '@fuzdev/fuz_schema/schema.ts';

import { generate_api_token, is_api_token_shaped } from '#lib/auth/api_token.ts';
import {
	read_bearer_token,
	read_daemon_token,
	read_session_cookie_value
} from '#lib/auth/credential_headers.ts';
import { generate_daemon_token, is_daemon_token_shaped } from '#lib/auth/daemon_token.ts';
import {
	create_session_config,
	create_session_cookie_value,
	is_cookie_value
} from '#lib/auth/session_cookie.ts';
import { to_thrown_jsonrpc_error } from '#lib/http/jsonrpc_errors.ts';
import { resolve_issues_invalid_reason } from '#lib/schema_meta.ts';
import {
	assert_credential_conformance,
	build_credential_conformance_placeholders,
	CREDENTIAL_CONFORMANCE_PLACEHOLDERS,
	fill_credential_conformance_placeholders,
	load_credential_conformance,
	to_credential_conformance_checks
} from '#lib/testing/cross_backend/credential_conformance.ts';
import {
	ERROR_TESTING_CREDENTIAL_READ_LINE,
	run_testing_credential_read,
	SessionCookieRead,
	TESTING_CREDENTIAL_READ_LINE_LENGTH_MAX,
	TESTING_CREDENTIAL_READ_LINES_MAX,
	TestingCredentialReadInput,
	type TestingCredentialReadOutput
} from '#lib/testing/cross_backend/testing_credential_read.ts';

import { create_test_keyring } from './session_test_helpers.ts';

const table = load_credential_conformance();
const keyring = create_test_keyring();
const session_options = create_session_config('fuz_session');

/** This leg's placeholders: credentials of its own, signed with its own keyring. */
const build_placeholders = async () =>
	build_credential_conformance_placeholders({
		cookie_name: session_options.cookie_name,
		session_cookie: await create_session_cookie_value(keyring, 'session-token', session_options),
		api_token: generate_api_token().token,
		daemon_token: generate_daemon_token(),
		keyring
	});

/**
 * Read `lines` as the action does — its input schema, then its handler's
 * function: the reading, or the `data.reason` of the refusal.
 */
const read_lines = async (
	lines: Array<string>
): Promise<{ answer: TestingCredentialReadOutput } | { refused: unknown }> => {
	const input = { lines };
	const parsed = parse(TestingCredentialReadInput, input);
	if (!parsed.ok) {
		return {
			refused: resolve_issues_invalid_reason(TestingCredentialReadInput, parsed.issues, input)
		};
	}
	try {
		return {
			answer: await run_testing_credential_read(parsed.value, { keyring, session_options })
		};
	} catch (error) {
		const thrown = to_thrown_jsonrpc_error(error);
		if (!thrown) throw error;
		return { refused: (thrown.data as { reason?: unknown } | undefined)?.reason };
	}
};

describe('credential conformance table', () => {
	test('every row gets the reading it names', async () => {
		const checks = to_credential_conformance_checks(table, await build_placeholders());
		const answers = [];
		for (const check of checks) {
			const read = await read_lines(check.lines);
			assert.ok('answer' in read, `${check.label}: refused`);
			answers.push(read.answer);
		}
		assert_credential_conformance(checks, answers, 'ts');
	});

	test('every refused row is refused with its reason', async () => {
		const placeholders = await build_placeholders();
		for (const row of table.refused) {
			const lines = row.lines.map((line) =>
				fill_credential_conformance_placeholders(line, placeholders)
			);
			assert.deepStrictEqual(await read_lines(lines), { refused: row.reason }, row.name);
			assert.strictEqual(row.reason, ERROR_TESTING_CREDENTIAL_READ_LINE);
		}
	});

	test("the cap rows sit at the action's caps", async () => {
		const placeholders = await build_placeholders();
		const filled = (name: string): Array<string> => {
			const row = [...table.rows, ...table.refused].find((r) => r.name === name);
			assert.ok(row, `no row named '${name}'`);
			return row.lines.map((line) => fill_credential_conformance_placeholders(line, placeholders));
		};
		const longest = (lines: Array<string>): number => Math.max(...lines.map((l) => l.length));
		const at_length = filled('a line of exactly the length cap');
		assert.strictEqual(longest(at_length), TESTING_CREDENTIAL_READ_LINE_LENGTH_MAX);
		const over_length = filled('a line one character over the length cap');
		assert.strictEqual(longest(over_length), TESTING_CREDENTIAL_READ_LINE_LENGTH_MAX + 1);
		assert.ok(over_length.length <= TESTING_CREDENTIAL_READ_LINES_MAX);
		const at_count = filled('exactly the cap of lines');
		assert.strictEqual(at_count.length, TESTING_CREDENTIAL_READ_LINES_MAX);
		const over_count = filled('one line over the cap of lines');
		assert.strictEqual(over_count.length, TESTING_CREDENTIAL_READ_LINES_MAX + 1);
		assert.ok(longest(over_count) <= TESTING_CREDENTIAL_READ_LINE_LENGTH_MAX);
	});

	test('every refusal of the lines carries the one reason', async () => {
		const reason_of = (input: unknown): string | undefined => {
			const parsed = parse(TestingCredentialReadInput, input);
			assert.ok(!parsed.ok);
			return resolve_issues_invalid_reason(TestingCredentialReadInput, parsed.issues, input);
		};
		for (const input of [{}, { lines: 'Cookie: a=1' }, { lines: [1] }, { lines: [null] }]) {
			assert.strictEqual(
				reason_of(input),
				ERROR_TESTING_CREDENTIAL_READ_LINE,
				JSON.stringify(input)
			);
		}
		// an unknown key is refused on the input itself, with no field's reason
		assert.strictEqual(reason_of({ lines: [], other: 1 }), undefined);
	});

	test('the clear follows from the cookie reading alone', () => {
		for (const row of table.rows) {
			assert.strictEqual(
				row.clears_session_cookie,
				row.read.session_cookie === 'invalid',
				`${row.name}: a cookie is cleared exactly when it is present and invalid`
			);
		}
	});

	test('a credential authenticates only when its leg read it, in leg order', () => {
		for (const row of table.rows) {
			const { read, authenticates } = row;
			if (read.daemon_token === '{daemon_token}') {
				assert.strictEqual(authenticates, 'daemon_token', `${row.name}: the daemon token is first`);
				continue;
			}
			assert.notStrictEqual(authenticates, 'daemon_token', row.name);
			if (authenticates === 'session') {
				assert.strictEqual(read.session_cookie, 'valid', row.name);
			} else if (authenticates === 'api_token') {
				assert.strictEqual(read.bearer_token, '{api_token}', row.name);
			} else if (read.session_cookie === 'valid') {
				// nothing authenticates a valid cookie only when its session row is gone
				assert.ok(
					row.lines.some((line) => line.includes('{session_cookie_rowless}')),
					`${row.name}: a valid cookie that authenticates nothing must be the rowless one`
				);
			}
		}
	});

	test('rows are unique by name and by lines', () => {
		const rows = [...table.rows, ...table.refused];
		const names = rows.map((row) => row.name);
		assert.strictEqual(new Set(names).size, names.length, 'duplicate row name');
		const lines = rows.map((row) => JSON.stringify(row.lines));
		assert.strictEqual(new Set(lines).size, lines.length, 'duplicate row lines');
	});

	test('every reading, every credential, and every placeholder appears', () => {
		for (const reading of SessionCookieRead.def) {
			assert.ok(
				table.rows.some((row) => row.read.session_cookie === reading),
				`no row reads the session cookie ${reading}`
			);
		}
		for (const credential of ['session', 'api_token', 'daemon_token', null]) {
			assert.ok(
				table.rows.some((row) => row.authenticates === credential),
				`no row authenticates as ${String(credential)}`
			);
		}
		const text = JSON.stringify(table);
		for (const name of CREDENTIAL_CONFORMANCE_PLACEHOLDERS) {
			assert.ok(text.includes(`{${name}}`), `no row uses {${name}}`);
		}
	});

	test('every read row is a request a client can send', () => {
		// a control byte in a field value never reaches the spine — a parser
		// refuses the request — so such lines are refused rows, not read rows
		for (const row of table.rows) {
			for (const line of row.lines) {
				for (const char of line) {
					const code = char.charCodeAt(0);
					assert.ok(
						code === 0x09 || (code >= 0x20 && code !== 0x7f && code <= 0xff),
						`${row.name}: U+${code.toString(16).padStart(4, '0')} is no header byte`
					);
				}
			}
		}
	});
});

describe('the credential readers', () => {
	test('no token grammar admits the `, ` a runtime joins repeated lines with', () => {
		// what makes a joined pair read as the repeat it is, on a runtime that
		// shows no per-line view: neither shape can hold a comma or a space
		const api_token = generate_api_token().token;
		const daemon_token = generate_daemon_token();
		for (const separator of [', ', ',', ' ']) {
			assert.strictEqual(is_api_token_shaped(`${api_token}${separator}${api_token}`), false);
			assert.strictEqual(
				is_daemon_token_shaped(`${daemon_token}${separator}${daemon_token}`),
				false
			);
			for (let i = 0; i <= api_token.length; i++) {
				const spliced = api_token.slice(0, i) + separator + api_token.slice(i + separator.length);
				assert.strictEqual(is_api_token_shaped(spliced), false, spliced);
			}
		}
		assert.strictEqual(read_bearer_token([`Bearer ${api_token}, Bearer ${api_token}`]), null);
		assert.strictEqual(read_daemon_token([`${daemon_token}, ${daemon_token}`]), null);
	});

	test('a repeated header is discarded whatever its lines hold', () => {
		const api_token = generate_api_token().token;
		const daemon_token = generate_daemon_token();
		assert.strictEqual(read_bearer_token([`Bearer ${api_token}`]), api_token);
		assert.strictEqual(read_bearer_token([`Bearer ${api_token}`, `Bearer ${api_token}`]), null);
		assert.strictEqual(read_bearer_token([`Bearer ${api_token}`, '']), null);
		assert.strictEqual(read_bearer_token([]), null);
		assert.strictEqual(read_daemon_token([daemon_token]), daemon_token);
		assert.strictEqual(read_daemon_token([daemon_token, daemon_token]), null);
		assert.strictEqual(read_daemon_token([daemon_token, '']), null);
		assert.strictEqual(read_daemon_token([]), null);
	});

	test('the cookie value is returned verbatim, and an empty one is not absent', () => {
		assert.strictEqual(read_session_cookie_value([], 's'), null);
		assert.strictEqual(read_session_cookie_value(['a=1'], 's'), null);
		assert.strictEqual(read_session_cookie_value(['s='], 's'), '');
		assert.strictEqual(read_session_cookie_value(['s=a%3Ab'], 's'), 'a%3Ab');
		assert.strictEqual(read_session_cookie_value(['s="q"'], 's'), '"q"');
		assert.strictEqual(read_session_cookie_value(['s= v'], 's'), ' v');
		assert.strictEqual(read_session_cookie_value(['s=a=b'], 's'), 'a=b');
		assert.strictEqual(read_session_cookie_value(['a=1', 's=2'], 's'), '2');
		assert.strictEqual(read_session_cookie_value(['s=1', 's=2'], 's'), '1');
	});

	test('a minted cookie value reads back as written', async () => {
		const value = await create_session_cookie_value(keyring, 'session-token', session_options);
		assert.ok(is_cookie_value(value));
		assert.strictEqual(
			read_session_cookie_value(
				[`a=1; ${session_options.cookie_name}=${value}`],
				session_options.cookie_name
			),
			value
		);
	});
});
