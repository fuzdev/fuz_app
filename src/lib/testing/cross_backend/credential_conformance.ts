import '../assert_dev_env.ts';

/**
 * The credential conformance table, and the cross-backend suite that runs it
 * through each backend's `_testing_credential_read` action.
 *
 * `credential_conformance.json` (beside this module) is the one statement of
 * how both spines read the three credential headers — the session cookie in
 * `Cookie`, the API token in `Authorization: Bearer`, the daemon token in
 * `X-Daemon-Token` (`auth/credential_headers.ts`, the Rust
 * `fuz_auth::credential_headers`). It holds two tables:
 *
 * - **rows** — `{name, lines, read, authenticates, clears_session_cookie}`:
 *   a request's credential header lines (each `Name: value`; a name may
 *   repeat), how each credential leg reads them (`read`), and what a request
 *   carrying them observably does — which credential authenticates it
 *   (`null` for none) and whether the response clears the session cookie.
 * - **refused** — `{name, lines, reason}`: lines that are no header lines at
 *   all, or more or longer lines than the action reads
 *   (`TESTING_CREDENTIAL_READ_LINES_MAX`,
 *   `TESTING_CREDENTIAL_READ_LINE_LENGTH_MAX`), which
 *   `_testing_credential_read` refuses with `invalid_params` and that reason.
 *
 * A line is bytes, one per character: a character U+0080–U+00FF is that byte
 * on the wire, which a runtime hands a handler as the same character.
 *
 * Live values are per run, so lines and expected tokens name them with
 * `{placeholders}` (`CredentialConformancePlaceholders`), which each leg fills
 * from its own keyring and credentials. The legs:
 *
 * - the TS unit test, through the action's input schema and
 *   `run_testing_credential_read`;
 * - the Rust unit test in `fuz_testing`, over a byte-identical copy of the
 *   file (fuz_app's cross-backend parity project holds the two copies
 *   byte-equal);
 * - `describe_credential_conformance_cross_tests` here, sending every row to
 *   a backend's `_testing_credential_read` action;
 * - `credential_conformance_wire.ts`, sending each row's lines as a real
 *   request and asserting `authenticates` and `clears_session_cookie`.
 *
 * A row may carry a `note` for the reader. Edited by hand, never generated.
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import { assert, describe, test } from 'vitest';
import {
	array,
	boolean,
	literal,
	min_length,
	nullable,
	object,
	one_of,
	optional,
	parse,
	parse_or_throw,
	pipe,
	string,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

import { BUILTIN_CREDENTIAL_TYPES } from '../../auth/credential_type_schema.ts';
import { create_keyring, type Keyring } from '../../auth/keyring.ts';
import { cross_rpc_call, error_reason } from './cross_rpc.ts';
import type { SetupTest, TestFixture } from './setup.ts';
import { SPINE_RPC_PATH } from './spine_surface_constants.ts';
import {
	ERROR_TESTING_CREDENTIAL_READ_LINE,
	TestingCredentialReadOutput,
	testing_credential_read_action_spec
} from './testing_credential_read.ts';

/**
 * A read row: header lines, each leg's reading of them, and the observable
 * outcome of a request carrying them.
 */
export const CredentialConformanceRow = object({
	name: string,
	lines: array(string),
	read: TestingCredentialReadOutput,
	/** The credential that authenticates the request, `null` when none does. */
	authenticates: nullable(one_of(BUILTIN_CREDENTIAL_TYPES)),
	/** Whether the response carries the clearing session `Set-Cookie`. */
	clears_session_cookie: boolean,
	note: optional(string)
});
export type CredentialConformanceRow = Infer<typeof CredentialConformanceRow>;

/** A refused row: lines `_testing_credential_read` refuses — no header lines, or past its caps. */
export const CredentialConformanceRefusedRow = object({
	name: string,
	lines: array(string),
	reason: literal(ERROR_TESTING_CREDENTIAL_READ_LINE),
	note: optional(string)
});
export type CredentialConformanceRefusedRow = Infer<typeof CredentialConformanceRefusedRow>;

/** The conformance table, a `@fuzdev/fuz_schema` `object`. */
export const CredentialConformance = object({
	rows: pipe(array(CredentialConformanceRow), min_length(1)),
	refused: pipe(array(CredentialConformanceRefusedRow), min_length(1))
});
export type CredentialConformance = Infer<typeof CredentialConformance>;

/** The committed table, resolved relative to this module. */
export const CREDENTIAL_CONFORMANCE_URL: URL = new URL(
	'./credential_conformance.json',
	import.meta.url
);

/**
 * Read and validate the committed conformance table.
 *
 * @returns the parsed table
 * @throws Error when the file doesn't match `CredentialConformance`
 */
export const load_credential_conformance = (): CredentialConformance =>
	parse_or_throw(
		CredentialConformance,
		JSON.parse(readFileSync(CREDENTIAL_CONFORMANCE_URL, 'utf8'))
	);

/** The placeholder names a row may use, each written `{name}` in the table. */
export const CREDENTIAL_CONFORMANCE_PLACEHOLDERS = [
	'cookie_name',
	'cookie_name_upper',
	'session_cookie',
	'session_cookie_percent_encoded',
	'session_cookie_bad_mac',
	'session_cookie_expired',
	'session_cookie_empty_identity',
	'session_cookie_rowless',
	'api_token',
	'daemon_token'
] as const;

/** A placeholder name — see `CREDENTIAL_CONFORMANCE_PLACEHOLDERS`. */
export type CredentialConformancePlaceholder = (typeof CREDENTIAL_CONFORMANCE_PLACEHOLDERS)[number];

/** The value each placeholder takes on one leg. */
export type CredentialConformancePlaceholders = Readonly<
	Record<CredentialConformancePlaceholder, string>
>;

/** What `build_credential_conformance_placeholders` builds the values from. */
export interface CredentialConformancePlaceholderInput {
	/** The session cookie's name. */
	readonly cookie_name: string;
	/**
	 * A signed session cookie value the reader's keyring verifies — on a live
	 * backend, one whose `auth_session` row exists.
	 */
	readonly session_cookie: string;
	/** A well-formed API token — on a live backend, one that authenticates. */
	readonly api_token: string;
	/** A well-formed daemon token — on a live backend, the keeper's. */
	readonly daemon_token: string;
	/** The keyring the reader verifies with, to sign the other cookie spellings. */
	readonly keyring: Keyring;
}

/** The base64 alphabet's first two characters, swapped to break a MAC. */
const swap_first_signature_char = (signed: string): string => {
	const dot = signed.lastIndexOf('.');
	assert.ok(dot !== -1, 'a signed cookie value holds a `.` before its signature');
	const first = signed[dot + 1];
	return signed.slice(0, dot + 1) + (first === 'A' ? 'B' : 'A') + signed.slice(dot + 2);
};

/**
 * Build one leg's placeholder values: the given live credentials, and the
 * cookie spellings derived from them or signed with the reader's keyring.
 *
 * - `session_cookie_percent_encoded` — `encodeURIComponent` of the valid
 *   cookie, what a framework's cookie serializer writes;
 * - `session_cookie_bad_mac` — the valid cookie with its signature's first
 *   character changed;
 * - `session_cookie_expired` — a signed payload whose expiry is an hour gone;
 * - `session_cookie_empty_identity` — a signed payload with no identity;
 * - `session_cookie_rowless` — a signed, unexpired payload naming a session
 *   token no row holds.
 *
 * @param input - the live credentials and the keyring
 * @returns the value of every placeholder
 * @throws Error when a derived spelling would equal the valid cookie, which would make its row vacuous
 */
export const build_credential_conformance_placeholders = async (
	input: CredentialConformancePlaceholderInput
): Promise<CredentialConformancePlaceholders> => {
	const { cookie_name, session_cookie, api_token, daemon_token, keyring } = input;
	const now = Math.floor(Date.now() / 1000);
	const placeholders: CredentialConformancePlaceholders = {
		cookie_name,
		cookie_name_upper: cookie_name.toUpperCase(),
		session_cookie,
		session_cookie_percent_encoded: encodeURIComponent(session_cookie),
		session_cookie_bad_mac: swap_first_signature_char(session_cookie),
		session_cookie_expired: await keyring.sign(`credential-conformance-expired:${now - 3600}`),
		session_cookie_empty_identity: await keyring.sign(`:${now + 3600}`),
		session_cookie_rowless: await keyring.sign(`credential-conformance-rowless:${now + 3600}`),
		api_token,
		daemon_token
	};
	if (placeholders.cookie_name_upper === cookie_name) {
		throw new Error(`cookie name '${cookie_name}' has no lowercase letter to change the case of`);
	}
	if (placeholders.session_cookie_percent_encoded === session_cookie) {
		throw new Error('the session cookie percent-encodes to itself — its row would be vacuous');
	}
	return placeholders;
};

const PLACEHOLDER_REGEX = /\{([a-z_]+)\}/g;

/**
 * Fill a table string's `{placeholders}`.
 *
 * @param text - a header line or an expected token
 * @param placeholders - the leg's values
 * @returns `text` with each placeholder replaced
 * @throws Error on a `{name}` that is no known placeholder
 */
export const fill_credential_conformance_placeholders = (
	text: string,
	placeholders: CredentialConformancePlaceholders
): string =>
	text.replace(PLACEHOLDER_REGEX, (_match, name: string) => {
		if (!Object.hasOwn(placeholders, name)) {
			throw new Error(`unknown credential conformance placeholder {${name}}`);
		}
		return placeholders[name as CredentialConformancePlaceholder];
	});

/** One read row with its placeholders filled. */
export interface CredentialConformanceCheck {
	/** The row's name, for a failure message. */
	readonly label: string;
	/** The row as the table states it. */
	readonly row: CredentialConformanceRow;
	/** The row's lines, filled. */
	readonly lines: Array<string>;
	/** The row's `read`, its tokens filled. */
	readonly expected: TestingCredentialReadOutput;
}

/**
 * Fill every read row's lines and expected tokens.
 *
 * @param table - the conformance table
 * @param placeholders - the leg's values
 * @returns one check per read row, in table order
 */
export const to_credential_conformance_checks = (
	table: CredentialConformance,
	placeholders: CredentialConformancePlaceholders
): Array<CredentialConformanceCheck> =>
	table.rows.map((row): CredentialConformanceCheck => {
		const fill = (text: string): string =>
			fill_credential_conformance_placeholders(text, placeholders);
		return {
			label: row.name,
			row,
			lines: row.lines.map(fill),
			expected: {
				session_cookie: row.read.session_cookie,
				bearer_token: row.read.bearer_token === null ? null : fill(row.read.bearer_token),
				daemon_token: row.read.daemon_token === null ? null : fill(row.read.daemon_token)
			}
		};
	});

/**
 * Compare each check's reading with its expectation and fail once, listing
 * every row that disagrees. Tokens are named by placeholder in the message,
 * never printed.
 *
 * @param checks - the table's checks
 * @param answers - the reading each check got, in order
 * @param backend - the name the failure message gives the answerer
 */
export const assert_credential_conformance = (
	checks: ReadonlyArray<CredentialConformanceCheck>,
	answers: ReadonlyArray<unknown>,
	backend: string
): void => {
	const failures: Array<string> = [];
	checks.forEach((check, i) => {
		const got = answers[i];
		try {
			assert.deepStrictEqual(got, check.expected);
		} catch {
			failures.push(
				`${check.label}: expected ${JSON.stringify(check.row.read)}, got ${describe_reading(got, check)}`
			);
		}
	});
	assert.ok(
		failures.length === 0,
		`${backend}: ${failures.length} of ${checks.length} credential conformance rows disagree:\n` +
			failures.join('\n')
	);
};

/** A reading for a failure message, its tokens reduced to whether they are the expected ones. */
const describe_reading = (got: unknown, check: CredentialConformanceCheck): string => {
	const reading = parse(TestingCredentialReadOutput, got);
	if (!reading.ok) return 'an answer that is no reading';
	const token = (value: string | null, expected: string | null): string | null =>
		value === null ? null : value === expected ? 'the expected token' : 'another token';
	return JSON.stringify({
		session_cookie: reading.value.session_cookie,
		bearer_token: token(reading.value.bearer_token, check.expected.bearer_token),
		daemon_token: token(reading.value.daemon_token, check.expected.daemon_token)
	});
};

/** Options for `describe_credential_conformance_cross_tests`. */
export interface CredentialConformanceCrossTestOptions {
	/** Per-test fixture producer (cross-process). */
	readonly setup_test: SetupTest;
	/** The spine's session cookie name (`handle.config.cookie_name`). */
	readonly cookie_name: string;
	/**
	 * The backend's `SECRET_FUZ_COOKIE_KEYS` value
	 * (`handle.config.env.SECRET_FUZ_COOKIE_KEYS`) — the suite signs the cookie
	 * spellings the table names with its primary key.
	 */
	readonly cookie_keys: string;
	/** A valid daemon token (keeper) — `handle.daemon_token`. */
	readonly daemon_token: string;
	/** JSON-RPC endpoint path. Default `SPINE_RPC_PATH`. */
	readonly rpc_path?: string;
}

/**
 * Build the keyring a backend verifies cookies with, from its
 * `SECRET_FUZ_COOKIE_KEYS` value.
 *
 * @param cookie_keys - the backend's `SECRET_FUZ_COOKIE_KEYS`
 * @throws Error when the value is no valid keyring
 */
export const create_credential_conformance_keyring = (cookie_keys: string): Keyring => {
	const result = create_keyring(cookie_keys);
	if (!result.ok) {
		throw new Error(`cookie_keys is not a valid keyring: ${result.errors.join('; ')}`);
	}
	return result.keyring;
};

/**
 * The placeholders of a live backend, from the fixture's keeper: its session
 * cookie and API token, and the daemon token.
 */
const keeper_placeholders = (
	fixture: TestFixture,
	options: Pick<CredentialConformanceCrossTestOptions, 'cookie_name' | 'daemon_token'>,
	keyring: Keyring
): Promise<CredentialConformancePlaceholders> => {
	const cookie = fixture.create_session_headers().cookie ?? '';
	const prefix = `${options.cookie_name}=`;
	assert.ok(cookie.startsWith(prefix), `the keeper session headers carry '${options.cookie_name}'`);
	const authorization = fixture.create_bearer_headers().authorization ?? '';
	assert.ok(authorization.startsWith('Bearer '), 'the keeper bearer headers carry a token');
	return build_credential_conformance_placeholders({
		cookie_name: options.cookie_name,
		session_cookie: cookie.slice(prefix.length),
		api_token: authorization.slice('Bearer '.length),
		daemon_token: options.daemon_token,
		keyring
	});
};

/**
 * Register the credential conformance suite: every row of the committed
 * table, sent to the backend's `_testing_credential_read` action over the
 * keeper's daemon-token channel, must get the reading the table names, and
 * every refused row the `invalid_params` refusal with its reason. The suite
 * skips itself on a backend that doesn't declare the action.
 *
 * The lines travel as JSON strings, each character one byte, so a row with a
 * non-ASCII byte reaches the action as it would reach a handler.
 */
export const describe_credential_conformance_cross_tests = (
	options: CredentialConformanceCrossTestOptions
): void => {
	const { setup_test } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;
	const table = load_credential_conformance();
	const method = testing_credential_read_action_spec.method;
	const keyring = create_credential_conformance_keyring(options.cookie_keys);

	describe('credential conformance', () => {
		test('every table row gets the reading it names', async () => {
			const fixture = await setup_test();
			const checks = to_credential_conformance_checks(
				table,
				await keeper_placeholders(fixture, options, keyring)
			);
			// Origin-free: the daemon-token middleware discards the credential in a
			// browser context, and the cross-process transport adds an `Origin`
			const transport = fixture.fresh_transport({ origin: null });
			const headers = fixture.create_daemon_token_headers();
			const answers: Array<unknown> = [];
			for (const check of checks) {
				const res = await cross_rpc_call(
					transport,
					rpc_path,
					method,
					{ lines: check.lines },
					headers
				);
				assert.ok(res.ok, `${check.label}: RPC failed: ${JSON.stringify(res.error)}`);
				const parsed = parse(TestingCredentialReadOutput, res.result);
				answers.push(parsed.ok ? parsed.value : res.result);
			}
			assert_credential_conformance(checks, answers, 'backend');
		});

		test('every refused row is refused with its reason', async () => {
			const fixture = await setup_test();
			const placeholders = await keeper_placeholders(fixture, options, keyring);
			const transport = fixture.fresh_transport({ origin: null });
			const headers = fixture.create_daemon_token_headers();
			for (const row of table.refused) {
				const lines = row.lines.map((line) =>
					fill_credential_conformance_placeholders(line, placeholders)
				);
				const res = await cross_rpc_call(transport, rpc_path, method, { lines }, headers);
				assert.strictEqual(res.ok, false, `${row.name}: must be refused`);
				assert.strictEqual(res.status, 400, `${row.name}: invalid_params`);
				assert.strictEqual(error_reason(res), row.reason, row.name);
			}
		});
	});
};
