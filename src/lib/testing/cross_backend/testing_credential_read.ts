import '../assert_dev_env.ts';

/**
 * `_testing_credential_read` — the testing seam behind the cross-impl
 * credential conformance table (`credential_conformance.json`): its input and
 * output schemas, the pure read it answers with, its spec, and the action
 * builder.
 *
 * A leaf like `testing_origin_check.ts`, and hono-free for the same reason: a
 * consumer whose backend is a spawned Rust binary runs the table without
 * installing `hono`.
 *
 * @module
 */

import {
	array,
	max_length,
	nullable,
	object,
	one_of,
	pipe,
	string,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';
import { meta } from '@fuzdev/fuz_schema/meta.ts';

import { rpc_action, type RpcAction } from '../../actions/action_types.ts';
import type { RequestResponseActionSpec } from '../../actions/action_spec.ts';
import {
	read_bearer_token,
	read_daemon_token,
	read_session_cookie_value
} from '../../auth/credential_headers.ts';
import { DAEMON_TOKEN_HEADER } from '../../auth/daemon_token.ts';
import type { Keyring } from '../../auth/keyring.ts';
import { process_session_cookie, type SessionOptions } from '../../auth/session_cookie.ts';
import { trim_optional_whitespace } from '../../http/header_lines.ts';
import { jsonrpc_errors } from '../../http/jsonrpc_errors.ts';
import { bounded_string } from '../../primitive_schemas.ts';
import { TESTING_ACTION_AUTH } from './spine_surface_constants.ts';

/**
 * The `data.reason` of every refusal `_testing_credential_read` gives its
 * `lines`: a value that is no list of strings, a list or a line over its cap
 * (`TESTING_CREDENTIAL_READ_LINES_MAX`,
 * `TESTING_CREDENTIAL_READ_LINE_LENGTH_MAX`), and a line it cannot read as a
 * header line — no `:`, a name that is no HTTP token, or a character that is
 * no byte a field value holds: above U+00FF (a line is bytes, one per
 * character), or a control character other than HTAB, which an HTTP parser
 * refuses before any spine code runs.
 */
export const ERROR_TESTING_CREDENTIAL_READ_LINE = 'invalid_header_line';

/**
 * The longest header line `_testing_credential_read` reads, in UTF-16 code
 * units — one a byte for every character a line may hold. A cap both spines
 * state, so neither reads a line the other's header types refuse for its
 * length; far above any credential line.
 */
export const TESTING_CREDENTIAL_READ_LINE_LENGTH_MAX = 1024;

/** The most header lines `_testing_credential_read` reads — both spines' cap. */
export const TESTING_CREDENTIAL_READ_LINES_MAX = 32;

/** Input of `_testing_credential_read`, a `@fuzdev/fuz_schema` `object`. */
export const TestingCredentialReadInput = object({
	/**
	 * The request's header lines, each `Name: value`, in the order sent — a
	 * name may repeat. Every character is one byte a field value may hold
	 * (HTAB, U+0020–U+007E, U+0080–U+00FF), as a runtime hands a handler a
	 * header's bytes. At most `TESTING_CREDENTIAL_READ_LINES_MAX` lines of at
	 * most `TESTING_CREDENTIAL_READ_LINE_LENGTH_MAX` characters each.
	 */
	lines: meta(
		pipe(
			array(bounded_string({ max: TESTING_CREDENTIAL_READ_LINE_LENGTH_MAX })),
			max_length(TESTING_CREDENTIAL_READ_LINES_MAX)
		),
		{ invalid_reason: ERROR_TESTING_CREDENTIAL_READ_LINE }
	)
});
export type TestingCredentialReadInput = Infer<typeof TestingCredentialReadInput>;

/**
 * What a request's `Cookie` lines hold of the session cookie — the wire form
 * of the Rust spine's `fuz_auth::SessionCookieRead`, its variants in
 * lowercase.
 */
export const SessionCookieRead = one_of(['absent', 'invalid', 'valid']);
export type SessionCookieRead = Infer<typeof SessionCookieRead>;

/**
 * Output of `_testing_credential_read`, a `@fuzdev/fuz_schema` `object`: how
 * each credential leg reads the lines, before any database work.
 */
export const TestingCredentialReadOutput = object({
	/**
	 * `absent` — no pair names the cookie; `invalid` — one does and its value
	 * fails verification (what the spine clears); `valid` — it verifies under
	 * the server's keyring and its signed expiry is ahead. Says nothing about
	 * the `auth_session` row.
	 */
	session_cookie: SessionCookieRead,
	/** The API token the bearer leg would look up, or `null` when it reads none. */
	bearer_token: nullable(string),
	/** The daemon token the daemon leg would compare, or `null` when it reads none. */
	daemon_token: nullable(string)
});
export type TestingCredentialReadOutput = Infer<typeof TestingCredentialReadOutput>;

/** What `run_testing_credential_read` verifies the session cookie with. */
export interface TestingCredentialReadDeps {
	/** The server's cookie keyring. */
	readonly keyring: Keyring;
	/** The server's session options — the cookie name and identity decoder. */
	readonly session_options: SessionOptions<string>;
}

/** An HTTP field name: an RFC 9110 `token`. */
const HEADER_NAME_REGEX = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/;

/**
 * Whether every character of `line` is a byte a header line may hold: HTAB,
 * visible ASCII and SP, or `obs-text` (U+0080–U+00FF).
 */
const is_header_line_bytes = (line: string): boolean => {
	for (let i = 0; i < line.length; i++) {
		const code = line.charCodeAt(i);
		if (code > 0xff || code === 0x7f || (code < 0x20 && code !== 0x09)) return false;
	}
	return true;
};

/**
 * Split `Name: value` lines into the per-name lines the credential readers
 * take — what an HTTP parser does to a request head: the name ends at the
 * first `:` and compares in ASCII lowercase, the value loses its outer SP and
 * HTAB, and lines of one name keep their order.
 *
 * @param lines - the header lines
 * @returns the lines of a header by its lowercase name (`[]` for a header not sent)
 * @throws ThrownJsonrpcError `invalid_params` with reason `ERROR_TESTING_CREDENTIAL_READ_LINE` for a line with no `:`, a name that is no token, or a character no header line holds
 */
export const parse_testing_header_lines = (
	lines: ReadonlyArray<string>
): ((lower_name: string) => ReadonlyArray<string>) => {
	const by_name: Map<string, Array<string>> = new Map();
	for (const line of lines) {
		const colon = line.indexOf(':');
		const name = colon === -1 ? '' : line.slice(0, colon);
		if (!HEADER_NAME_REGEX.test(name) || !is_header_line_bytes(line)) {
			throw jsonrpc_errors.invalid_params('a header line must be `Name: value` in bytes', {
				reason: ERROR_TESTING_CREDENTIAL_READ_LINE
			});
		}
		const lower_name = name.toLowerCase();
		let values = by_name.get(lower_name);
		if (!values) by_name.set(lower_name, (values = []));
		values.push(trim_optional_whitespace(line.slice(colon + 1)));
	}
	return (lower_name) => by_name.get(lower_name) ?? [];
};

/**
 * Answer one `_testing_credential_read` input: read each credential out of
 * the lines with the readers the auth middleware legs call
 * (`read_session_cookie_value` then `process_session_cookie`,
 * `read_bearer_token`, `read_daemon_token`). The action handler and the
 * conformance table's unit test both call this, so the table checks the same
 * functions the wire serves.
 *
 * @param input - the header lines
 * @param deps - the keyring and session options the cookie is verified with
 * @returns the reading the Rust twin returns for the same lines
 * @throws ThrownJsonrpcError `invalid_params` for a line `parse_testing_header_lines` refuses
 */
export const run_testing_credential_read = async (
	input: TestingCredentialReadInput,
	deps: TestingCredentialReadDeps
): Promise<TestingCredentialReadOutput> => {
	const header = parse_testing_header_lines(input.lines);
	const session = await process_session_cookie(
		read_session_cookie_value(header('cookie'), deps.session_options.cookie_name),
		deps.keyring,
		deps.session_options
	);
	return {
		session_cookie: session.valid ? 'valid' : session.action === 'clear' ? 'invalid' : 'absent',
		bearer_token: read_bearer_token(header('authorization')),
		daemon_token: read_daemon_token(header(DAEMON_TOKEN_HEADER.toLowerCase()))
	};
};

/**
 * `_testing_credential_read` — read the three credentials out of a list of
 * header lines, so the shared conformance table
 * (`credential_conformance.json`) checks each backend's header grammar over
 * the wire, row by row. Pure: no database, no state beyond the server's
 * keyring and cookie name. The Rust mirror is
 * `fuz_testing::create_testing_credential_read_action_spec`.
 *
 * Like `_testing_origin_check`, it is **not** bundled by
 * `create_testing_actions`: a consumer whose Rust binary doesn't mount the
 * mirror would fail its action-manifest parity gate. The spine test binary
 * appends it at the full-mount layer (`build_full_spine_rpc_actions`).
 *
 * `auth` gates on the daemon-token credential, matching `_testing_reset`.
 */
export const testing_credential_read_action_spec = {
	method: '_testing_credential_read',
	kind: 'request_response',
	initiator: 'frontend',
	auth: TESTING_ACTION_AUTH,
	side_effects: false,
	input: TestingCredentialReadInput,
	output: TestingCredentialReadOutput,
	async: true,
	error_reasons: [ERROR_TESTING_CREDENTIAL_READ_LINE],
	description:
		'Test-binary only — read the session cookie, bearer token and daemon token out of ' +
		'{lines}, for the cross-impl credential conformance table.'
} as const satisfies RequestResponseActionSpec;

/**
 * Build the standalone `_testing_credential_read` action (see the spec doc).
 *
 * @param deps - the server's keyring and session options
 */
export const create_testing_credential_read_action = (deps: TestingCredentialReadDeps): RpcAction =>
	rpc_action(testing_credential_read_action_spec, (input) =>
		run_testing_credential_read(input, deps)
	);
