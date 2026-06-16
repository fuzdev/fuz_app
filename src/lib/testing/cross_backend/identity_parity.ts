import '../assert_dev_env.ts';

/**
 * Cross-backend identity-primitive parity for fuz_app's own spine over real
 * HTTP — the `primitive_schemas` twins (`Username`, `UsernameProvided`,
 * `Email`) and the login/signup input handling that enforces them, pinned
 * facet-by-facet so a TS↔Rust divergence in any one surfaces as a failure:
 * how usernames are **canonicalized** on the login lookup, the **ASCII-only
 * creation invariant** that bounds what can ever be stored, and the **email
 * format** rule applied at signup.
 *
 * `UsernameProvided` (login/lookup) canonicalizes the submitted username via
 * `.trim().toLowerCase()`, and the DB matches case-insensitively
 * (`LOWER(username) = LOWER($1)`); `Username` (creation) lowercases at store
 * **and** restricts to ASCII via `^[a-zA-Z][0-9a-zA-Z_-]*[0-9a-zA-Z]$`. The
 * Rust spine must produce the same canonical form, the same case-insensitive
 * lookup, **and** the same ASCII-only rejection — or a username that logs in on
 * TS silently 401s on Rust, or a non-ASCII username storable on one backend
 * reopens the homograph-collision surface. The spec-derived round-trip +
 * conformance suites never vary username casing or charset, so this corner was
 * unpinned.
 *
 * **Canonicalization (login lookup):**
 *
 * - **case-insensitive login** — an account created `Mixed_Case` logs in via an
 *   all-uppercase submission (proves the *lookup* folds case, not merely that
 *   the stored form was lowercased).
 * - **whitespace-trim login** — the same shape logs in with surrounding
 *   whitespace (proves `.trim()` on the lookup path).
 * - **no Unicode case-fold collision (negative)** — a Turkish-`İ` (U+0130)
 *   variant of an existing ASCII username must NOT match. Both JS
 *   `.toLowerCase()` and Rust `str::to_lowercase()` map `İ` → `i` + U+0307
 *   (combining dot above), never plain `i`, so the cased homograph stays a
 *   distinct, non-existent username → 401 on every backend.
 *
 * **Username-or-email login lookup:** the login identifier resolves against
 * **username or email** — TS `query_account_by_username_or_email`, Rust the
 * converged `query_account_with_password_hash` OR-lookup (this was the
 * divergence the suite closed: the Rust spine previously matched username
 * only). An account created with an email logs in via that email,
 * case-insensitively (`Email` stores the original case; folding rides the
 * `LOWER(email) = LOWER($1)` lookup), and username login keeps working when an
 * email is present. A non-existent email → 401.
 *
 * **Login input validation:** malformed login input → 400 `invalid_request_body`
 * on every spine — whitespace-only username (empty after trim), over-long
 * username (> 255), empty password, and an unknown body key (strict object).
 * TS runs the full `LoginInput` Zod schema; the Rust spine enforces the same
 * shape in `account_login` (the convergence the suite closed: the Rust spine
 * previously let three of these fall through to a lookup-miss 401, and TS let a
 * whitespace-only identifier through to a 401). Asserted via the error reason,
 * not just the status, so a same-status-wrong-body backend still fails.
 *
 * **ASCII-only creation invariant:** a non-ASCII username is rejected at signup
 * input validation → 400 on every backend, so no Unicode username is ever
 * stored — the precondition the login no-collision case relies on. (ASCII-only
 * is the intended invariant for both spines, not an accident of the TS regex.)
 *
 * **Length + format creation parity:** the full `Username` shape —
 * `[USERNAME_LENGTH_MIN, USERNAME_LENGTH_MAX]` = `[3, 39]` and the regex
 * `^[a-zA-Z][0-9a-zA-Z_-]*[0-9a-zA-Z]$` — pinned across both backends. The TS
 * Zod `.min()/.max()/.regex()` and the Rust hand-rolled byte-scan
 * (`is_valid_username_for_creation`) are independent reimplementations of the
 * same rule, so each length boundary is tested just-outside (→ 400) and
 * just-inside (→ 403 no-matching-invite, the settle for a valid username on a
 * spine with `open_signup` at its `false` default), and each format violation
 * (leading non-letter, trailing punctuation, embedded disallowed char) → 400,
 * with mid-string `_`/`-` accepted siblings as the don't-over-reject control.
 * Signup is also strict-object on both spines (TS `z.strictObject`, Rust
 * `#[serde(deny_unknown_fields)]`), so an unknown signup body key → 400.
 *
 * **Email format (creation):** the optional signup `email` is validated to a
 * loose `local@domain.tld` shape on both spines — TS `Email`
 * (`^[^\s@]+@[^\s@]+\.[^\s@]+$` plus a 254-byte (RFC 5321 octet) length bound; whitespace `White_Space ∪ {U+FEFF}`), Rust the
 * hand-rolled `is_valid_email`. A malformed email → 400, a well-formed one →
 * 403 no-matching-invite (the same accept/reject settle the username tables
 * use). The accepted siblings include the single-char-TLD `a@b.c` that Zod's
 * `z.email()` would reject — the deliberately-looser rule both spines now
 * share. This closed a real divergence: the Rust spine previously
 * length-checked the email only, accepting any non-empty string TS rejected.
 *
 * Both surfaces are flat REST on every spine, so this is an imperative suite
 * (not a `conformance_table` row) and ungated. Runs both legs via the shared
 * `{setup_test}` protocol: the in-process leg
 * (`cross_backend/identity_parity.db.test.ts`, plain `gro test`) and the
 * cross-process leg (`cross_backend/identity_parity.cross.test.ts`, the TS spine
 * binaries + Rust `testing_spine_stub` over real HTTP).
 *
 * `$lib`-free by contract (relative specifiers only).
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {
	ERROR_INVALID_CREDENTIALS,
	ERROR_INVALID_REQUEST_BODY,
	ERROR_NO_MATCHING_INVITE,
} from '../../http/error_schemas.ts';
import {DEFAULT_TEST_PASSWORD} from '../test_credentials.ts';
import type {SetupTest} from './setup.ts';

/**
 * The flat-REST `{error}` reason each terminal login/signup status carries on
 * every spine — the assertion target that turns a status-only check into a
 * body-shape check. `200` carries no `error` field (`{ok: true}`), so its
 * expected reason is `undefined`. Asserting the reason (not just the status)
 * catches a backend that returns the right status with a wrong, renamed, or
 * info-leaking body — drift the status comparison is blind to. Wire constants,
 * not literals, so a rename in `error_schemas.ts` fails the typecheck here.
 */
const REASON_BY_STATUS: Readonly<Record<number, string | undefined>> = {
	200: undefined,
	400: ERROR_INVALID_REQUEST_BODY,
	401: ERROR_INVALID_CREDENTIALS,
	403: ERROR_NO_MATCHING_INVITE,
};

/** Options for the identity-primitive parity suite. */
export interface IdentityParityCrossTestOptions {
	/** Per-test fixture producer (in-process or cross-process). */
	readonly setup_test: SetupTest;
	/** REST login route path. Default `/api/account/login` (the spine convention). */
	readonly login_path?: string;
	/** REST signup route path. Default `/api/account/signup` (the spine convention). */
	readonly signup_path?: string;
}

/**
 * U+0130 LATIN CAPITAL LETTER I WITH DOT ABOVE. Its Unicode default lowercase
 * is `i` + U+0307 (combining dot above), never plain `i` — the property the
 * negative case relies on for a stable cross-impl result.
 */
const TURKISH_DOTTED_I = 'İ';

/** A signup username case: the submitted username, a human label, and the status it must settle to. */
interface SignupUsernameCase {
	readonly username: string;
	readonly label: string;
	readonly status: number;
}

/**
 * Representative non-ASCII usernames spanning distinct scripts — accented Latin
 * (mid-string), Greek (leading), CJK (leading). Each fails the `Username` regex
 * at a different position, so a Rust regex that admitted any one script (but not
 * another) is caught. All → 400 at signup input validation.
 */
const USERNAME_NON_ASCII_CASES: ReadonlyArray<SignupUsernameCase> = [
	{username: 'café_user', label: 'accented Latin mid-string', status: 400},
	{username: 'Ωmega_user', label: 'leading Greek', status: 400},
	{username: '日本_user', label: 'leading CJK', status: 400},
];

/**
 * Status a signup with a **valid** username (but no matching invite, on a
 * spine whose `open_signup` stays at the production default `false`) settles
 * to: the username cleared input validation and reached the invite gate, which
 * finds no match → 403 `no_matching_invite`. The accepted boundary/format
 * cases below assert this (not 200): the point is that the username was *not*
 * rejected at validation, distinguishing it from the 400 cases.
 */
const VALID_USERNAME_NO_INVITE_STATUS = 403;

/**
 * Username length boundary pairs for the creation schema, pinning both edges of
 * `[USERNAME_LENGTH_MIN, USERNAME_LENGTH_MAX]` = `[3, 39]`. Each pair is a
 * just-outside length (rejected at input validation → 400) and its just-inside
 * sibling (cleared validation → 403). Pinning both sides on both backends
 * catches an off-by-one in either impl's min/max check — the TS `.min()/.max()`
 * vs the Rust `s.len() < MIN || s.len() > MAX` byte-length scan. Every value is
 * otherwise valid (leading letter, alphanumeric tail, alphanumeric body) so the
 * only variable is length.
 */
const USERNAME_LENGTH_CASES: ReadonlyArray<SignupUsernameCase> = [
	{username: 'ab', label: '2 chars — below min', status: 400},
	{username: 'abc', label: '3 chars — at min', status: VALID_USERNAME_NO_INVITE_STATUS},
	{
		username: `a${'b'.repeat(38)}`,
		label: '39 chars — at max',
		status: VALID_USERNAME_NO_INVITE_STATUS,
	},
	{username: `a${'b'.repeat(39)}`, label: '40 chars — above max', status: 400},
];

/**
 * Username format edge cases for the creation regex
 * `^[a-zA-Z][0-9a-zA-Z_-]*[0-9a-zA-Z]$`. The rejected cases each violate the
 * shape at a different position — leading non-letter, trailing punctuation,
 * embedded disallowed char — so a Rust byte-scan that policed only one position
 * is caught. The two accepted siblings (`_` / `-` *mid-string*) are the
 * non-divergence control: the same characters that are illegal at the end are
 * legal in the body, so they must clear validation (→ 403) on every backend —
 * pinning that neither impl over-rejects them.
 */
const USERNAME_FORMAT_CASES: ReadonlyArray<SignupUsernameCase> = [
	{username: '1user', label: 'leading digit', status: 400},
	{username: '_user', label: 'leading underscore', status: 400},
	{username: '-user', label: 'leading dash', status: 400},
	{username: 'user_', label: 'trailing underscore', status: 400},
	{username: 'user-', label: 'trailing dash', status: 400},
	{username: 'us er', label: 'embedded space', status: 400},
	{username: 'user@x', label: 'embedded at-sign', status: 400},
	{username: 'user.x', label: 'embedded dot', status: 400},
	{
		username: 'us_er',
		label: 'underscore mid-string (valid)',
		status: VALID_USERNAME_NO_INVITE_STATUS,
	},
	{username: 'us-er', label: 'dash mid-string (valid)', status: VALID_USERNAME_NO_INVITE_STATUS},
];

/** A signup email case: the submitted email, a human label, and the status it must settle to. */
interface SignupEmailCase {
	readonly email: string;
	readonly label: string;
	readonly status: number;
}

/**
 * Signup email-format cases for the loose `Email` shape `local@domain.tld`
 * (TS `^[^\s@]+@[^\s@]+\.[^\s@]+$` plus the 254 length bound; Rust the
 * hand-rolled `is_valid_email`). The rejected cases each violate the shape at
 * a different point — no `@`, no dot in the domain, empty local/domain, a dot
 * at a domain edge, surrounding whitespace, over the length bound — so a
 * backend policing only one of them is caught. The accepted siblings are the
 * don't-over-reject control and include the shapes Zod's `z.email()` rejects
 * but our looser rule accepts — single-char TLD `a@b.c` and consecutive dots
 * `a..b@c.d` — pinning the deliberately-looser shared rule in both directions.
 * Every case rides a valid username so the rejection (or the 403 no-invite
 * settle) isolates the email.
 */
const SIGNUP_EMAIL_CASES: ReadonlyArray<SignupEmailCase> = [
	{email: 'not-an-email', label: 'no @ or dot', status: 400},
	{email: 'user@host', label: 'no dot in domain', status: 400},
	{email: '@example.com', label: 'empty local part', status: 400},
	{email: 'user@', label: 'empty domain', status: 400},
	{email: 'user@.com', label: 'domain starts with a dot', status: 400},
	{email: 'user@com.', label: 'domain ends with a dot', status: 400},
	{email: 'a@@b.c', label: 'two @', status: 400},
	{email: ' user@example.com', label: 'leading whitespace', status: 400},
	{email: 'user@example.com ', label: 'trailing whitespace', status: 400},
	{email: 'us er@example.com', label: 'internal whitespace', status: 400},
	{email: 'a\u0085b@c.d', label: 'NEL U+0085 (Unicode ws JS \\s omits)', status: 400},
	{email: 'a\ufeffb@c.d', label: 'BOM/ZWNBSP U+FEFF', status: 400},
	// 255 bytes total (243-char local + "@example.com") — one over the 254-byte bound.
	{email: `${'a'.repeat(243)}@example.com`, label: 'over the 254-byte bound (ASCII)', status: 400},
	// Multibyte: the bound is UTF-8 BYTES, not code units. `\u00fc` (ü) is 2
	// bytes / 1 code unit, so 121×ü + "@example.com" is 254 bytes (accepted) and
	// 122×ü is 256 bytes (rejected) — both far under 254 code units, so a
	// code-unit `.max(254)` would wrongly accept the over case. Pins the byte
	// bound across both spines (the Rust `is_valid_email` `s.len()`).
	{
		email: `${'\u00fc'.repeat(121)}@example.com`,
		label: 'multibyte at the 254-byte bound',
		status: VALID_USERNAME_NO_INVITE_STATUS,
	},
	{
		email: `${'\u00fc'.repeat(122)}@example.com`,
		label: 'multibyte over the 254-byte bound',
		status: 400,
	},
	{email: 'user@example.com', label: 'well-formed', status: VALID_USERNAME_NO_INVITE_STATUS},
	{
		email: 'a@b.c',
		label: 'single-char TLD (looser than z.email)',
		status: VALID_USERNAME_NO_INVITE_STATUS,
	},
	{
		email: 'a..b@c.d',
		label: 'consecutive dots (looser than z.email)',
		status: VALID_USERNAME_NO_INVITE_STATUS,
	},
	{
		email: 'user+tag@example.co.uk',
		label: 'plus-tag + multi-label',
		status: VALID_USERNAME_NO_INVITE_STATUS,
	},
];

export const describe_identity_parity_cross_tests = (
	options: IdentityParityCrossTestOptions,
): void => {
	const {setup_test} = options;
	const login_path = options.login_path ?? '/api/account/login';
	const signup_path = options.signup_path ?? '/api/account/signup';

	type Fixture = Awaited<ReturnType<typeof setup_test>>;
	/** The status + flat-REST `error` reason an attempt settled to. */
	interface Attempt {
		readonly status: number;
		readonly error: string | undefined;
	}

	/**
	 * POST JSON on a fresh (cookie-jar-free) transport; return the status and the
	 * parsed flat-REST `{error}` reason (`undefined` for success / non-JSON
	 * bodies). Always reads the body so the cross-process socket releases.
	 */
	const post_json = async (
		fixture: Fixture,
		path: string,
		body: Record<string, unknown>,
	): Promise<Attempt> => {
		const res = await fixture.fresh_transport()(path, {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify(body),
		});
		const text = await res.text().catch(() => '');
		let error: string | undefined;
		try {
			const parsed: unknown = text ? JSON.parse(text) : undefined;
			if (
				parsed &&
				typeof parsed === 'object' &&
				typeof (parsed as {error?: unknown}).error === 'string'
			) {
				error = (parsed as {error: string}).error;
			}
		} catch {
			// non-JSON body — leave `error` undefined.
		}
		return {status: res.status, error};
	};

	/** POST a login with the given identifier (username or email). */
	const login = (
		fixture: Fixture,
		username: string,
		password: string = DEFAULT_TEST_PASSWORD,
	): Promise<Attempt> => post_json(fixture, login_path, {username, password});

	/** POST a signup with a valid password and the given username. */
	const signup = (
		fixture: Fixture,
		username: string,
		password: string = DEFAULT_TEST_PASSWORD,
	): Promise<Attempt> => post_json(fixture, signup_path, {username, password});

	/**
	 * Assert an attempt settled to `status` **and** carried the flat-REST error
	 * reason that status implies on every spine (see {@link REASON_BY_STATUS}) —
	 * a body-shape check, not just a status check, so a backend can't pass by
	 * returning the right status with the wrong/leaky body.
	 */
	const assert_attempt = (actual: Attempt, status: number, label: string): void => {
		assert.strictEqual(
			actual.status,
			status,
			`${label} — expected status ${status}, got ${actual.status}`,
		);
		const expected_reason = REASON_BY_STATUS[status];
		assert.strictEqual(
			actual.error,
			expected_reason,
			`${label} — status ${status} must carry error reason ${expected_reason ?? '(none)'}, got ${actual.error ?? '(none)'}`,
		);
	};

	/** Run a table of signup username cases, asserting each settles to its expected `{status, reason}`. */
	const describe_signup_username_cases = (
		suite_name: string,
		cases: ReadonlyArray<SignupUsernameCase>,
	): void => {
		describe(suite_name, () => {
			for (const {username, label, status} of cases) {
				test(`${label} — "${username}" → ${status}`, async () => {
					const fixture = await setup_test();
					assert_attempt(
						await signup(fixture, username),
						status,
						`username "${username}" (${label})`,
					);
				});
			}
		});
	};

	describe('username canonicalization parity', () => {
		test('case-insensitive login — uppercase submission matches a mixed-case account', async () => {
			const fixture = await setup_test();
			// Mixed-case ASCII username (valid per the `Username` regex), stored
			// lowercase; an all-uppercase submission matches only if the lookup
			// folds case on this backend.
			await fixture.create_account({username: 'Canon_Mixed_User'});
			assert_attempt(await login(fixture, 'CANON_MIXED_USER'), 200, 'uppercase login');
		});

		test('whitespace-trim login — surrounding whitespace is trimmed on lookup', async () => {
			const fixture = await setup_test();
			await fixture.create_account({username: 'Canon_Trim_User'});
			assert_attempt(await login(fixture, '  canon_trim_user  '), 200, 'whitespace-trim login');
		});

		test('no Unicode case-fold collision — Turkish İ variant of an ASCII username → 401', async () => {
			const fixture = await setup_test();
			// `canon_admin_user` carries an ASCII `i`; the probe replaces it with İ
			// (U+0130). A backend that folded İ → plain `i` would match the stored
			// username and authenticate (the bug); both impls fold İ → `i` + U+0307,
			// so the canonical form differs and the lookup misses → 401
			// `invalid_credentials` (asserted, not just the status — a backend that
			// 401'd with a different body would still be wrong).
			await fixture.create_account({username: 'canon_admin_user'});
			const homograph = `canon_adm${TURKISH_DOTTED_I}n_user`;
			assert_attempt(await login(fixture, homograph), 401, 'Turkish-İ homograph');
		});
	});

	describe('username-or-email login parity', () => {
		// The login identifier matches against **username or email** (TS
		// `query_account_by_username_or_email`, Rust the converged
		// `query_account_with_password_hash` OR-lookup). An account that carries
		// an email logs in via that email, case-insensitively, on every backend —
		// the property that was unpinned (and divergent: the Rust spine matched
		// username only) until this suite. Email is stored with its original case
		// (`Email` does not lowercase), so case folding rides entirely on the
		// `LOWER(email) = LOWER($1)` lookup, exercised by the mixed-case cases.

		test('login by exact email — an account created with an email logs in via that email', async () => {
			const fixture = await setup_test();
			await fixture.create_account({
				username: 'email_exact_user',
				email: 'email-exact@example.com',
			});
			assert_attempt(await login(fixture, 'email-exact@example.com'), 200, 'exact-email login');
		});

		test('email login is case-insensitive — mixed-case stored email, lowercase submission', async () => {
			const fixture = await setup_test();
			await fixture.create_account({
				username: 'email_mixed_user',
				email: 'Email.Mixed@Example.COM',
			});
			assert_attempt(
				await login(fixture, 'email.mixed@example.com'),
				200,
				'mixed-case-email login',
			);
		});

		test('email login is case-insensitive — lowercase stored email, uppercase submission', async () => {
			const fixture = await setup_test();
			await fixture.create_account({
				username: 'email_upper_user',
				email: 'email-upper@example.com',
			});
			assert_attempt(await login(fixture, 'EMAIL-UPPER@EXAMPLE.COM'), 200, 'uppercase-email login');
		});

		test('username login still works when the account also has an email', async () => {
			const fixture = await setup_test();
			await fixture.create_account({
				username: 'email_dual_user',
				email: 'email-dual@example.com',
			});
			assert_attempt(
				await login(fixture, 'email_dual_user'),
				200,
				'username login with email present',
			);
		});

		test('login by a non-existent email → 401', async () => {
			const fixture = await setup_test();
			await fixture.create_account({
				username: 'email_present_user',
				email: 'email-present@example.com',
			});
			assert_attempt(
				await login(fixture, 'email-absent@example.com'),
				401,
				'non-existent-email login',
			);
		});
	});

	describe('login input validation parity', () => {
		// Malformed login input → 400 `invalid_request_body` on every spine. TS
		// runs the full `LoginInput` Zod schema (`UsernameProvided` non-empty /
		// max 255 / non-empty-after-trim, `PasswordProvided` non-empty / max 300,
		// `z.strictObject`); the Rust spine enforces the same shape in
		// `account_login` (an extra key fails `deny_unknown_fields` → 400, not
		// axum's 422). These each previously fell through to a lookup-miss 401 (or
		// a bespoke-string 400) on one backend — a status *and* body divergence the
		// strengthened `assert_attempt` (reason-checked) now pins.

		test('whitespace-only username → 400 (empty after trim, not a lookup miss)', async () => {
			const fixture = await setup_test();
			assert_attempt(await login(fixture, '   '), 400, 'whitespace-only username');
		});

		test('over-long username (>255) → 400', async () => {
			const fixture = await setup_test();
			assert_attempt(await login(fixture, 'a'.repeat(256)), 400, 'over-long username');
		});

		test('empty password → 400 (rejected as malformed, not a wrong credential)', async () => {
			const fixture = await setup_test();
			assert_attempt(await login(fixture, 'some_user', ''), 400, 'empty password');
		});

		test('over-long password (>300) → 400', async () => {
			const fixture = await setup_test();
			assert_attempt(await login(fixture, 'some_user', 'a'.repeat(301)), 400, 'over-long password');
		});

		test('unknown body key → 400 (strict object on both spines)', async () => {
			const fixture = await setup_test();
			assert_attempt(
				await post_json(fixture, login_path, {
					username: 'some_user',
					password: DEFAULT_TEST_PASSWORD,
					unexpected_field: 'x',
				}),
				400,
				'unknown body key',
			);
		});
	});

	// The `Username` creation schema is ASCII-only by regex; both spines reject a
	// non-ASCII username at signup input validation → 400, so no Unicode username
	// is ever stored (the precondition the no-collision login case relies on).
	describe_signup_username_cases(
		'username creation ASCII-only invariant parity',
		USERNAME_NON_ASCII_CASES,
	);

	// Both edges of `[USERNAME_LENGTH_MIN, USERNAME_LENGTH_MAX]` = [3, 39], each
	// side just-outside (→ 400) and just-inside (→ 403). Catches an off-by-one in
	// either backend's length check.
	describe_signup_username_cases('username creation length boundary parity', USERNAME_LENGTH_CASES);

	// The creation regex `^[a-zA-Z][0-9a-zA-Z_-]*[0-9a-zA-Z]$` — rejected shapes
	// (→ 400) and the mid-string `_`/`-` controls that must be accepted (→ 403),
	// proving neither backend over- or under-rejects.
	describe_signup_username_cases('username creation format parity', USERNAME_FORMAT_CASES);

	// The optional signup `email` is validated to the loose `local@domain.tld`
	// shape on both spines (TS `Email` regex + 254-byte bound, Rust `is_valid_email`):
	// malformed → 400, well-formed → 403 no-invite. The username is fixed-valid so
	// each case isolates the email; the `a@b.c` accept pins the deliberately
	// looser-than-`z.email()` rule the validator port converged on.
	describe('signup email format parity', () => {
		for (const {email, label, status} of SIGNUP_EMAIL_CASES) {
			test(`${label} → ${status}`, async () => {
				const fixture = await setup_test();
				assert_attempt(
					await post_json(fixture, signup_path, {
						username: 'email_fmt_user',
						password: DEFAULT_TEST_PASSWORD,
						email,
					}),
					status,
					`email "${email}" (${label})`,
				);
			});
		}

		// `null` email (not just absent) — TS `Email.nullish()` + the Rust
		// `Option<String>` (serde maps JSON null → None) both treat it as
		// "no email", so signup reaches the invite gate → 403, not a 400.
		// Pins the null-vs-absent convergence the `.nullish()` loosening made.
		test('null email is treated as absent (403, not 400)', async () => {
			const fixture = await setup_test();
			assert_attempt(
				await post_json(fixture, signup_path, {
					username: 'email_null_user',
					password: DEFAULT_TEST_PASSWORD,
					email: null,
				}),
				VALID_USERNAME_NO_INVITE_STATUS,
				'null email',
			);
		});
	});

	describe('signup input validation parity', () => {
		// Signup is `z.strictObject` on TS and `#[serde(deny_unknown_fields)]` on
		// the Rust spine — an unknown body key → 400 `invalid_request_body` on
		// both (the Rust spine previously ignored it via serde). The username is
		// valid so the rejection isolates the unknown key (a valid body would
		// otherwise reach the invite gate → 403).
		test('unknown body key → 400 (strict object on both spines)', async () => {
			const fixture = await setup_test();
			assert_attempt(
				await post_json(fixture, signup_path, {
					username: 'strict_signup_user',
					password: DEFAULT_TEST_PASSWORD,
					unexpected_field: 'x',
				}),
				400,
				'signup unknown body key',
			);
		});
	});
};
