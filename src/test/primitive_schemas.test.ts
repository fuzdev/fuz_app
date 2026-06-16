/**
 * Tests for `primitive_schemas.ts` — Username / UsernameProvided / Email.
 *
 * Pins the canonicalization contract: both `Username` and `UsernameProvided`
 * canonicalize at parse time so every creation / lookup site agrees on a
 * single normalized form. The storage canonicalization closes the parity
 * gap the zzz Rust port surfaced on 2026-05-16 — fuz_app's regex was
 * already strict enough to reject the whitespace bypass, but storage was
 * mixed-case, leaving login's manual `.trim().toLowerCase()` as a per-call
 * ritual that drifted across bootstrap / signup / admin-create.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {
	Username,
	UsernameProvided,
	Email,
	EMAIL_LENGTH_MAX,
	USERNAME_LENGTH_MIN,
	USERNAME_LENGTH_MAX,
	USERNAME_PROVIDED_LENGTH_MAX,
} from '$lib/primitive_schemas.ts';

// --- Username (creation schema) ---

describe('Username', () => {
	test('lowercases at parse time', () => {
		assert.strictEqual(Username.parse('Admin'), 'admin');
		assert.strictEqual(Username.parse('ADMIN'), 'admin');
		assert.strictEqual(Username.parse('MixedCase42'), 'mixedcase42');
	});

	test('passes through already-lowercase input unchanged', () => {
		assert.strictEqual(Username.parse('admin'), 'admin');
		assert.strictEqual(Username.parse('a1b2c3'), 'a1b2c3');
	});

	test('is idempotent under repeat parse', () => {
		const inputs = ['Admin', 'admin', 'TestUser_42', 'a1b'];
		for (const raw of inputs) {
			const once = Username.parse(raw);
			const twice = Username.parse(once);
			assert.strictEqual(once, twice, `Username not idempotent for '${raw}'`);
		}
	});

	test('rejects whitespace (regex enforced before transform)', () => {
		// Whitespace is rejected outright — no .trim() needed in the transform.
		// This is the property the Rust port's bootstrap canonicalization was
		// closing on its side; fuz_app's regex already gates it.
		assert.ok(!Username.safeParse(' admin').success);
		assert.ok(!Username.safeParse('admin ').success);
		assert.ok(!Username.safeParse(' admin ').success);
		assert.ok(!Username.safeParse('user name').success);
		assert.ok(!Username.safeParse('user\tname').success);
	});

	test('rejects emails / dots / @ — not a creation-format username', () => {
		assert.ok(!Username.safeParse('user@example.com').success);
		assert.ok(!Username.safeParse('user.name').success);
		assert.ok(!Username.safeParse('a.b').success);
	});

	test('rejects too-short / too-long input', () => {
		assert.ok(!Username.safeParse('').success);
		assert.ok(!Username.safeParse('ab').success);
		assert.ok(!Username.safeParse('a'.repeat(USERNAME_LENGTH_MAX + 1)).success);
		assert.ok(Username.safeParse('a'.repeat(USERNAME_LENGTH_MIN)).success);
		assert.ok(Username.safeParse('a'.repeat(USERNAME_LENGTH_MAX)).success);
	});

	test('rejects leading or trailing underscore / dash', () => {
		// Regex `[a-zA-Z][...][0-9a-zA-Z]` anchors start to letter and end to alphanumeric.
		assert.ok(!Username.safeParse('_admin').success);
		assert.ok(!Username.safeParse('admin_').success);
		assert.ok(!Username.safeParse('-admin').success);
		assert.ok(!Username.safeParse('admin-').success);
	});

	test('accepts mid-string underscores and dashes', () => {
		assert.strictEqual(Username.parse('test_user'), 'test_user');
		assert.strictEqual(Username.parse('test-user'), 'test-user');
		assert.strictEqual(Username.parse('Test_User-42'), 'test_user-42');
	});

	test('requires a leading letter', () => {
		assert.ok(!Username.safeParse('1admin').success);
		assert.ok(!Username.safeParse('9user_42').success);
	});
});

// --- UsernameProvided (login / lookup schema) ---

describe('UsernameProvided', () => {
	test('trims and lowercases at parse time', () => {
		assert.strictEqual(UsernameProvided.parse('  Admin  '), 'admin');
		assert.strictEqual(UsernameProvided.parse('\tADMIN\n'), 'admin');
		assert.strictEqual(UsernameProvided.parse(' user '), 'user');
	});

	test('lowercases without surrounding whitespace', () => {
		assert.strictEqual(UsernameProvided.parse('Admin'), 'admin');
		assert.strictEqual(UsernameProvided.parse('MixedCase'), 'mixedcase');
	});

	test('passes through already-canonical input unchanged', () => {
		assert.strictEqual(UsernameProvided.parse('admin'), 'admin');
	});

	test('is idempotent under repeat parse', () => {
		const inputs = ['  Admin  ', 'admin', 'USER', 'mAlFoRmEd@but.allowed'];
		for (const raw of inputs) {
			const once = UsernameProvided.parse(raw);
			const twice = UsernameProvided.parse(once);
			assert.strictEqual(once, twice, `UsernameProvided not idempotent for '${raw}'`);
		}
	});

	test('rejects too-short / too-long input', () => {
		// `min(1)` rejects the empty string outright; the trailing `.refine`
		// additionally rejects whitespace-only input that trims to empty (see the
		// dedicated case below).
		assert.ok(!UsernameProvided.safeParse('').success);
		assert.ok(!UsernameProvided.safeParse('a'.repeat(USERNAME_PROVIDED_LENGTH_MAX + 1)).success);
		assert.ok(UsernameProvided.safeParse('a').success);
		// Pin the at-max boundary symmetrically with the `Username` block above
		// — `min`/`max` is a single off-by-one site, so missing the at-max
		// accept assertion leaves the high bound only one-sided.
		assert.ok(UsernameProvided.safeParse('a'.repeat(USERNAME_PROVIDED_LENGTH_MAX)).success);
	});

	test('rejects whitespace-only input (empty after trim)', () => {
		// `min(1)` runs on the raw string (so a space passes the length gate), but
		// the trailing `.refine` rejects the empty post-trim value — a
		// whitespace-only identifier is malformed input, not a wrong credential.
		// The login handler therefore 400s it (`invalid_request_body`) rather than
		// routing `''` into a lookup-miss 401; the Rust spine's `account_login`
		// rejects empty-after-trim the same way. Pinned cross-impl by the
		// `identity_parity` login-validation suite.
		assert.ok(!UsernameProvided.safeParse(' ').success);
		assert.ok(!UsernameProvided.safeParse('   ').success);
		assert.ok(!UsernameProvided.safeParse('\t\n').success);
	});

	test('admits email-shaped input (login allows username-or-email)', () => {
		// `UsernameProvided` is the permissive login schema — `@` / `.` are
		// allowed so `query_account_by_username_or_email` can route to either
		// lookup. Canonical lowering applies uniformly.
		assert.strictEqual(UsernameProvided.parse('User@Example.com'), 'user@example.com');
		assert.strictEqual(UsernameProvided.parse(' USER@EXAMPLE.com '), 'user@example.com');
	});

	test('canonicalizes whitespace-surrounded input to the same key as bare input', () => {
		// Regression check for the bypass the Rust port closed: keying the
		// per-account rate limit on the raw submitted form means an attacker
		// can alternate ` admin` and `admin` to double the bucket. Both
		// canonicalize to `admin` here, so the rate-limit key (whatever the
		// caller derives from this) cannot drift.
		assert.strictEqual(UsernameProvided.parse('admin'), UsernameProvided.parse(' admin'));
		assert.strictEqual(UsernameProvided.parse('admin'), UsernameProvided.parse('Admin'));
		assert.strictEqual(UsernameProvided.parse('admin'), UsernameProvided.parse(' ADMIN '));
	});
});

// --- Cross-schema canonicalization parity ---

describe('Username/UsernameProvided cross-schema parity', () => {
	// Critical invariant: for any input both schemas accept, the canonical
	// form must be identical. Signup parses through `Username`, login parses
	// through `UsernameProvided`, and both feed `LOWER(username)` lookups
	// against the same DB row. If the schemas disagreed on canonicalization,
	// a user could sign up with one casing and find their account
	// unreachable at login (or, worse, two distinct accounts could collide
	// at lookup time).
	test('mixed-case input canonicalizes identically through both schemas', () => {
		const inputs = ['Admin', 'ADMIN', 'MixedCase42', 'a1b', 'Test_User-42'];
		for (const raw of inputs) {
			const via_creation = Username.parse(raw);
			const via_login = UsernameProvided.parse(raw);
			assert.strictEqual(
				via_creation,
				via_login,
				`schemas diverged for '${raw}': Username='${via_creation}', UsernameProvided='${via_login}'`,
			);
		}
	});

	test('lowercase input passes through identically', () => {
		const inputs = ['admin', 'a1b', 'test_user', 'user-42'];
		for (const raw of inputs) {
			assert.strictEqual(Username.parse(raw), UsernameProvided.parse(raw));
		}
	});

	test('inputs Username rejects but UsernameProvided accepts produce divergent acceptance', () => {
		// These are NOT a parity violation — they are the documented
		// asymmetry. `Username` is strict (creation must conform to the
		// canonical format); `UsernameProvided` is permissive (login must
		// accept any reasonable submission, including email-shaped inputs
		// and whitespace-surrounded forms that trim cleanly). The parity
		// invariant above only applies to inputs both schemas accept.
		// Pinning the asymmetry here makes the boundary explicit.
		assert.ok(!Username.safeParse(' admin ').success);
		assert.strictEqual(UsernameProvided.parse(' admin '), 'admin');

		assert.ok(!Username.safeParse('user@example.com').success);
		assert.strictEqual(UsernameProvided.parse('user@example.com'), 'user@example.com');

		assert.ok(!Username.safeParse('1leading_digit').success);
		assert.strictEqual(UsernameProvided.parse('1leading_digit'), '1leading_digit');
	});
});

// --- Username Unicode/homograph rejection ---

describe('Username homograph rejection (ASCII-only by regex)', () => {
	// `Username`'s regex `[a-zA-Z][0-9a-zA-Z_-]*[0-9a-zA-Z]` is intentionally
	// ASCII-only. This blocks classical homograph attacks where a
	// visually-identical Unicode character substitutes for an ASCII
	// letter (`αdmin` vs `admin`, `аdmin` Cyrillic vs `admin` Latin,
	// `ａｄｍｉｎ` full-width vs `admin`). If the regex is ever relaxed
	// to `\w` or a Unicode property class, a user could register a
	// look-alike of an admin account name. These tests pin the
	// rejection so the regex relaxation surfaces as a test failure.
	test('rejects Greek letter substitutions', () => {
		// α (U+03B1 GREEK SMALL LETTER ALPHA) visually matches 'a'
		assert.ok(!Username.safeParse('αdmin').success);
		// ο (U+03BF GREEK SMALL LETTER OMICRON) visually matches 'o'
		assert.ok(!Username.safeParse('rοot').success);
	});

	test('rejects Cyrillic letter substitutions', () => {
		// а (U+0430 CYRILLIC SMALL LETTER A) visually matches 'a'
		assert.ok(!Username.safeParse('аdmin').success);
		// о (U+043E CYRILLIC SMALL LETTER O) visually matches 'o'
		assert.ok(!Username.safeParse('rоt').success);
		// р (U+0440 CYRILLIC SMALL LETTER ER) visually matches 'p'
		assert.ok(!Username.safeParse('рaypal').success);
	});

	test('rejects full-width Latin substitutions', () => {
		// ａｄｍｉｎ (U+FF41 .. U+FF4E full-width Latin) visually matches 'admin'
		assert.ok(!Username.safeParse('ａｄｍｉｎ').success);
	});

	test('rejects mathematical bold / italic Latin substitutions', () => {
		// 𝐚 (U+1D41A MATHEMATICAL BOLD SMALL A) visually matches 'a'.
		// Surrogate pair in UTF-16 — Zod sees the codepoint as outside
		// [a-zA-Z]. Two char positions but one codepoint.
		assert.ok(!Username.safeParse('\u{1d41a}dmin').success);
	});

	test('rejects combining marks', () => {
		// 'a' + U+0301 COMBINING ACUTE ACCENT — looks like 'á' but stays
		// two codepoints. The combining mark fails the char class.
		assert.ok(!Username.safeParse('ádmin').success);
	});

	test('accepts plain ASCII (negative control)', () => {
		// Sanity: the rejection tests above should fail because of the
		// Unicode char, not the surrounding structure.
		assert.ok(Username.safeParse('admin').success);
		assert.ok(Username.safeParse('root').success);
		assert.ok(Username.safeParse('paypal').success);
	});
});

// --- Email ---

describe('Email', () => {
	test('accepts well-formed addresses', () => {
		assert.ok(Email.safeParse('user@example.com').success);
		assert.ok(Email.safeParse('user+tag@example.co.uk').success);
	});

	test('accepts shapes z.email() rejects — the deliberately-looser rule', () => {
		// `Email` is the loose `local@domain.tld` structural shape, not RFC
		// conformance. These all pass here but FAIL Zod's `z.email()` (1-char
		// TLDs, consecutive dots); pinning them keeps the chosen looser rule
		// honest — a refactor back to `z.email()` (or a stricter regex) turns
		// these red. The Rust spine's `is_valid_email` accepts them identically.
		assert.ok(Email.safeParse('a@b.c').success); // single-char TLD
		assert.ok(Email.safeParse('a..b@c.d').success); // consecutive dots in local
		assert.ok(Email.safeParse('a@b..c').success); // consecutive dots in domain
	});

	test('rejects malformed input', () => {
		assert.ok(!Email.safeParse('not-an-email').success);
		assert.ok(!Email.safeParse('').success);
		assert.ok(!Email.safeParse('@example.com').success); // empty local
		assert.ok(!Email.safeParse('user@').success); // empty domain
		assert.ok(!Email.safeParse('user@host').success); // no dot in domain
		assert.ok(!Email.safeParse('user@.com').success); // domain starts with dot
		assert.ok(!Email.safeParse('user@com.').success); // domain ends with dot
		assert.ok(!Email.safeParse('a@@b.c').success); // two `@`
	});

	test('enforces the length bound', () => {
		// 254 ASCII chars total: a 242-char local + "@example.com" (12).
		const at_max = `${'a'.repeat(EMAIL_LENGTH_MAX - 12)}@example.com`;
		assert.strictEqual(at_max.length, EMAIL_LENGTH_MAX);
		assert.ok(Email.safeParse(at_max).success);
		const over_max = `${'a'.repeat(EMAIL_LENGTH_MAX - 11)}@example.com`;
		assert.strictEqual(over_max.length, EMAIL_LENGTH_MAX + 1);
		assert.ok(!Email.safeParse(over_max).success);

		// The bound is UTF-8 BYTES (RFC 5321 octets), matching the Rust spine's
		// `s.len()`, not JS's UTF-16 `.length`. `\u00fc` (ü) is 2 bytes / 1 code
		// unit, so 122×ü is 256 bytes but only 134 code units: under 254
		// `.length` (a code-unit `.max(254)` would wrongly accept it) yet over the
		// 254-byte bound, so both spines must reject it.
		const mb_at_max = `${'\u00fc'.repeat(121)}@example.com`;
		assert.strictEqual(new TextEncoder().encode(mb_at_max).length, EMAIL_LENGTH_MAX);
		assert.ok(mb_at_max.length < EMAIL_LENGTH_MAX);
		assert.ok(Email.safeParse(mb_at_max).success);
		const mb_over = `${'\u00fc'.repeat(122)}@example.com`;
		assert.strictEqual(new TextEncoder().encode(mb_over).length, EMAIL_LENGTH_MAX + 2);
		assert.ok(mb_over.length < EMAIL_LENGTH_MAX);
		assert.ok(!Email.safeParse(mb_over).success);
	});

	test('passes through case unchanged (no canonicalization transform)', () => {
		// Deliberate asymmetry with `Username` — `Username` canonicalizes to
		// lowercase at parse time, but `Email` preserves the input case. The
		// case-insensitive lookup happens at the SQL layer via `LOWER()` in
		// `query_account_by_email` (see `auth/CLAUDE.md` §`account_queries.ts`),
		// so storage retains the user-supplied form and only the lookup
		// canonicalizes.
		//
		// This test pins the asymmetry — a refactor that adds
		// `.transform((s) => s.toLowerCase())` to `Email` would silently
		// re-canonicalize the storage shape, breaking the contract that the
		// DB-side `LOWER()` was the single canonicalization point. Stored
		// rows with mixed-case emails would round-trip correctly but new
		// inserts would diverge from the historic storage shape.
		assert.strictEqual(Email.parse('User@Example.com'), 'User@Example.com');
		assert.strictEqual(Email.parse('ADMIN@EXAMPLE.COM'), 'ADMIN@EXAMPLE.COM');
		assert.strictEqual(Email.parse('Mixed.Case+Tag@Foo.Bar'), 'Mixed.Case+Tag@Foo.Bar');
	});

	test('rejects whitespace anywhere (surrounding and internal, no trim)', () => {
		// Whitespace-bearing addresses fail the `[^\s\u0085@]` character class rather
		// than being silently trimmed — surrounding (the no-transform contract,
		// same intent as the case-preservation test) AND internal. Mirrors the
		// Rust `is_valid_email`, which rejects `White_Space ∪ {U+FEFF}`, so
		// storage is verbatim on both spines.
		assert.ok(!Email.safeParse(' user@example.com').success); // leading
		assert.ok(!Email.safeParse('user@example.com ').success); // trailing
		assert.ok(!Email.safeParse('us er@example.com').success); // internal (local)
		assert.ok(!Email.safeParse('user@exa mple.com').success); // internal (domain)
		assert.ok(!Email.safeParse('user@e\tx.com').success); // tab
		assert.ok(!Email.safeParse('a\u0085b@c.d').success); // NEL (U+0085)
		assert.ok(!Email.safeParse('a\ufeffb@c.d').success); // BOM/ZWNBSP (U+FEFF)
	});
});
