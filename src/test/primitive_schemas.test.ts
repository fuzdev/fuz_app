/**
 * Tests for `primitive_schemas.ts` — `Username`, `Email`, and the login
 * `UsernameProvided`, which pairs with `Username`.
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

import { describe, test, assert } from 'vitest';
import { is, parse, parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';

import {
	Username,
	UsernameProvided,
	Email,
	EMAIL_LENGTH_MAX,
	EMAIL_LENGTH_MESSAGE,
	EMAIL_REGEX,
	USERNAME_LENGTH_MIN,
	USERNAME_LENGTH_MAX,
	USERNAME_PROVIDED_LENGTH_MAX
} from '#lib/primitive_schemas.ts';

/** `UsernameProvided`'s output, throwing on a refusal. */
const provided = (raw: string): string => parse_or_throw(UsernameProvided, raw);

/**
 * The quadratic spelling of the `EMAIL_REGEX` grammar, the reference its
 * verdicts are held to. Never run it on a long input.
 */
const EMAIL_REGEX_REFERENCE =
	/^[^\s\u0085@]+@[^\s\u0085@.][^\s\u0085@]*\.[^\s\u0085@]*[^\s\u0085@.]$/;

/**
 * The Rust spine's `is_valid_email` but for its length bound, as it reads:
 * no whitespace, one `@` after a non-empty local part, and a domain that holds
 * a `.` and neither starts nor ends with one.
 */
const is_email_by_rule = (s: string): boolean => {
	if (s === '' || /[\s\u0085]/.test(s)) return false;
	const parts = s.split('@');
	if (parts.length !== 2 || parts[0] === '') return false;
	const domain = parts[1]!;
	return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
};

/** Calls `visit` on every string over `alphabet` of at most `max_length` characters. */
const each_string = (
	alphabet: ReadonlyArray<string>,
	max_length: number,
	visit: (s: string) => void
): void => {
	const extend = (s: string, remaining: number): void => {
		visit(s);
		if (remaining === 0) return;
		for (const c of alphabet) extend(s + c, remaining - 1);
	};
	extend('', max_length);
};

// --- Username (creation schema) ---

describe('Username', () => {
	test('lowercases at parse time', () => {
		assert.strictEqual(parse_or_throw(Username, 'Admin'), 'admin');
		assert.strictEqual(parse_or_throw(Username, 'ADMIN'), 'admin');
		assert.strictEqual(parse_or_throw(Username, 'MixedCase42'), 'mixedcase42');
	});

	test('passes through already-lowercase input unchanged', () => {
		assert.strictEqual(parse_or_throw(Username, 'admin'), 'admin');
		assert.strictEqual(parse_or_throw(Username, 'a1b2c3'), 'a1b2c3');
	});

	test('is idempotent under repeat parse', () => {
		const inputs = ['Admin', 'admin', 'TestUser_42', 'a1b'];
		for (const raw of inputs) {
			const once = parse_or_throw(Username, raw);
			const twice = parse_or_throw(Username, once);
			assert.strictEqual(once, twice, `Username not idempotent for '${raw}'`);
		}
	});

	test('rejects whitespace (regex enforced before transform)', () => {
		// Whitespace is rejected outright — no .trim() needed in the transform.
		// This is the property the Rust port's bootstrap canonicalization was
		// closing on its side; fuz_app's regex already gates it.
		assert.ok(!is(Username, ' admin'));
		assert.ok(!is(Username, 'admin '));
		assert.ok(!is(Username, ' admin '));
		assert.ok(!is(Username, 'user name'));
		assert.ok(!is(Username, 'user\tname'));
	});

	test('rejects emails / dots / @ — not a creation-format username', () => {
		assert.ok(!is(Username, 'user@example.com'));
		assert.ok(!is(Username, 'user.name'));
		assert.ok(!is(Username, 'a.b'));
	});

	test('rejects too-short / too-long input', () => {
		assert.ok(!is(Username, ''));
		assert.ok(!is(Username, 'ab'));
		assert.ok(!is(Username, 'a'.repeat(USERNAME_LENGTH_MAX + 1)));
		assert.ok(is(Username, 'a'.repeat(USERNAME_LENGTH_MIN)));
		assert.ok(is(Username, 'a'.repeat(USERNAME_LENGTH_MAX)));
	});

	test('rejects leading or trailing underscore / dash', () => {
		// Regex `[a-zA-Z][...][0-9a-zA-Z]` anchors start to letter and end to alphanumeric.
		assert.ok(!is(Username, '_admin'));
		assert.ok(!is(Username, 'admin_'));
		assert.ok(!is(Username, '-admin'));
		assert.ok(!is(Username, 'admin-'));
	});

	test('accepts mid-string underscores and dashes', () => {
		assert.strictEqual(parse_or_throw(Username, 'test_user'), 'test_user');
		assert.strictEqual(parse_or_throw(Username, 'test-user'), 'test-user');
		assert.strictEqual(parse_or_throw(Username, 'Test_User-42'), 'test_user-42');
	});

	test('requires a leading letter', () => {
		assert.ok(!is(Username, '1admin'));
		assert.ok(!is(Username, '9user_42'));
	});
});

// --- UsernameProvided (login / lookup schema) ---

describe('UsernameProvided', () => {
	test('trims and lowercases at parse time', () => {
		assert.strictEqual(provided('  Admin  '), 'admin');
		assert.strictEqual(provided('\tADMIN\n'), 'admin');
		assert.strictEqual(provided(' user '), 'user');
	});

	test('lowercases without surrounding whitespace', () => {
		assert.strictEqual(provided('Admin'), 'admin');
		assert.strictEqual(provided('MixedCase'), 'mixedcase');
	});

	test('passes through already-canonical input unchanged', () => {
		assert.strictEqual(provided('admin'), 'admin');
	});

	test('is idempotent under repeat parse', () => {
		const inputs = ['  Admin  ', 'admin', 'USER', 'mAlFoRmEd@but.allowed'];
		for (const raw of inputs) {
			const once = provided(raw);
			const twice = provided(once);
			assert.strictEqual(once, twice, `UsernameProvided not idempotent for '${raw}'`);
		}
	});

	test('rejects too-short / too-long input', () => {
		// `min_length(1)` rejects the empty string outright; the `regex(/\S/)`
		// additionally rejects whitespace-only input that trims to empty (see the
		// dedicated case below).
		assert.ok(!is(UsernameProvided, ''));
		assert.ok(!is(UsernameProvided, 'a'.repeat(USERNAME_PROVIDED_LENGTH_MAX + 1)));
		assert.ok(is(UsernameProvided, 'a'));
		// Pin the at-max boundary symmetrically with the `Username` block above
		// — `min`/`max` is a single off-by-one site, so missing the at-max
		// accept assertion leaves the high bound only one-sided.
		assert.ok(is(UsernameProvided, 'a'.repeat(USERNAME_PROVIDED_LENGTH_MAX)));
	});

	test('rejects whitespace-only input (empty after trim)', () => {
		// `min_length(1)` runs on the raw string (so a space passes the length
		// gate), but the `regex(/\S/)` rejects what would trim to empty — a
		// whitespace-only identifier is malformed input, not a wrong credential.
		// The login handler therefore 400s it (`invalid_request_body`) rather than
		// routing `''` into a lookup-miss 401; the Rust spine's `account_login`
		// rejects empty-after-trim the same way. Pinned cross-impl by the
		// `identity_parity` login-validation suite.
		assert.ok(!is(UsernameProvided, ' '));
		assert.ok(!is(UsernameProvided, '   '));
		assert.ok(!is(UsernameProvided, '\t\n'));
	});

	test('refuses exactly the strings that trim to empty, over every BMP code point', () => {
		// the `regex(/\S/)` stands for the trim: JS `\s` is `trim`'s set, so a
		// code point alone is refused exactly when it trims away
		const misses: Array<string> = [];
		for (let c = 0; c <= 0xffff; c++) {
			const ch = String.fromCharCode(c);
			if (is(UsernameProvided, ch) !== (ch.trim() !== '')) misses.push(c.toString(16));
		}
		assert.deepStrictEqual(misses, []);
	});

	test('refuses whitespace-only input with the trim message', () => {
		for (const raw of [' ', '﻿', ' ', ' ', '　 \t', ' '.repeat(255)]) {
			const result = parse(UsernameProvided, raw);
			assert.ok(!result.ok, JSON.stringify(raw));
			assert.deepStrictEqual(
				result.issues.map((i) => i.message),
				['Username must not be empty after trimming whitespace'],
				JSON.stringify(raw)
			);
		}
		// past the length bound, the length issue alone
		const over = parse(UsernameProvided, ' '.repeat(USERNAME_PROVIDED_LENGTH_MAX + 1));
		assert.ok(!over.ok);
		assert.deepStrictEqual(
			over.issues.map((i) => i.kind),
			['max_length']
		);
	});

	test('keeps what trim keeps', () => {
		// U+0085 and U+180E are not JS whitespace, and a lone surrogate is a code unit
		assert.strictEqual(provided('\u0085'), '\u0085');
		assert.strictEqual(provided('᠎'), '᠎');
		assert.strictEqual(provided(' \ud800 '), '\ud800');
		assert.strictEqual(provided('﻿Admin '), 'admin');
	});

	test('admits email-shaped input (login allows username-or-email)', () => {
		// `UsernameProvided` is the permissive login schema — `@` / `.` are
		// allowed so `query_account_by_username_or_email` can route to either
		// lookup. Canonical lowering applies uniformly.
		assert.strictEqual(provided('User@Example.com'), 'user@example.com');
		assert.strictEqual(provided(' USER@EXAMPLE.com '), 'user@example.com');
	});

	test('canonicalizes whitespace-surrounded input to the same key as bare input', () => {
		// Regression check for the bypass the Rust port closed: keying the
		// per-account rate limit on the raw submitted form means an attacker
		// can alternate ` admin` and `admin` to double the bucket. Both
		// canonicalize to `admin` here, so the rate-limit key (whatever the
		// caller derives from this) cannot drift.
		assert.strictEqual(provided('admin'), provided(' admin'));
		assert.strictEqual(provided('admin'), provided('Admin'));
		assert.strictEqual(provided('admin'), provided(' ADMIN '));
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
			const via_creation = parse_or_throw(Username, raw);
			const via_login = provided(raw);
			assert.strictEqual(
				via_creation,
				via_login,
				`schemas diverged for '${raw}': Username='${via_creation}', UsernameProvided='${via_login}'`
			);
		}
	});

	test('lowercase input passes through identically', () => {
		const inputs = ['admin', 'a1b', 'test_user', 'user-42'];
		for (const raw of inputs) {
			assert.strictEqual(parse_or_throw(Username, raw), provided(raw));
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
		assert.ok(!is(Username, ' admin '));
		assert.strictEqual(provided(' admin '), 'admin');

		assert.ok(!is(Username, 'user@example.com'));
		assert.strictEqual(provided('user@example.com'), 'user@example.com');

		assert.ok(!is(Username, '1leading_digit'));
		assert.strictEqual(provided('1leading_digit'), '1leading_digit');
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
		assert.ok(!is(Username, 'αdmin'));
		// ο (U+03BF GREEK SMALL LETTER OMICRON) visually matches 'o'
		assert.ok(!is(Username, 'rοot'));
	});

	test('rejects Cyrillic letter substitutions', () => {
		// а (U+0430 CYRILLIC SMALL LETTER A) visually matches 'a'
		assert.ok(!is(Username, 'аdmin'));
		// о (U+043E CYRILLIC SMALL LETTER O) visually matches 'o'
		assert.ok(!is(Username, 'rоt'));
		// р (U+0440 CYRILLIC SMALL LETTER ER) visually matches 'p'
		assert.ok(!is(Username, 'рaypal'));
	});

	test('rejects full-width Latin substitutions', () => {
		// ａｄｍｉｎ (U+FF41 .. U+FF4E full-width Latin) visually matches 'admin'
		assert.ok(!is(Username, 'ａｄｍｉｎ'));
	});

	test('rejects mathematical bold / italic Latin substitutions', () => {
		// 𝐚 (U+1D41A MATHEMATICAL BOLD SMALL A) visually matches 'a'.
		// Surrogate pair in UTF-16 — the regex sees the codepoint as outside
		// [a-zA-Z]. Two char positions but one codepoint.
		assert.ok(!is(Username, '\u{1d41a}dmin'));
	});

	test('rejects combining marks', () => {
		// 'a' + U+0301 COMBINING ACUTE ACCENT — looks like 'á' but stays
		// two codepoints. The combining mark fails the char class.
		assert.ok(!is(Username, 'ádmin'));
	});

	test('accepts plain ASCII (negative control)', () => {
		// Sanity: the rejection tests above should fail because of the
		// Unicode char, not the surrounding structure.
		assert.ok(is(Username, 'admin'));
		assert.ok(is(Username, 'root'));
		assert.ok(is(Username, 'paypal'));
	});
});

// --- Email ---

describe('Email', () => {
	test('accepts well-formed addresses', () => {
		assert.ok(is(Email, 'user@example.com'));
		assert.ok(is(Email, 'user+tag@example.co.uk'));
	});

	test('accepts shapes a strict email rule rejects — the deliberately-looser rule', () => {
		// `Email` is the loose `local@domain.tld` structural shape, not RFC
		// conformance. These all pass here but FAIL a stricter email rule (1-char
		// TLDs, consecutive dots); pinning them keeps the chosen looser rule
		// honest — a refactor to a stricter rule turns
		// these red. The Rust spine's `is_valid_email` accepts them identically.
		assert.ok(is(Email, 'a@b.c')); // single-char TLD
		assert.ok(is(Email, 'a..b@c.d')); // consecutive dots in local
		assert.ok(is(Email, 'a@b..c')); // consecutive dots in domain
	});

	test('rejects malformed input', () => {
		assert.ok(!is(Email, 'not-an-email'));
		assert.ok(!is(Email, ''));
		assert.ok(!is(Email, '@example.com')); // empty local
		assert.ok(!is(Email, 'user@')); // empty domain
		assert.ok(!is(Email, 'user@host')); // no dot in domain
		assert.ok(!is(Email, 'user@.com')); // domain starts with dot
		assert.ok(!is(Email, 'user@com.')); // domain ends with dot
		assert.ok(!is(Email, 'a@@b.c')); // two `@`
	});

	test('refuses a domain with a dot at either edge, as the Rust is_valid_email does', () => {
		// a domain with another dot inside still has a dot at its edge
		assert.ok(!is(Email, 'a@.b.c'));
		assert.ok(!is(Email, 'a@b.c.'));
		assert.ok(!is(Email, 'a@.b.c.'));
		assert.ok(!is(Email, 'a@..b'));
		assert.ok(!is(Email, 'a@b..'));
		assert.ok(!is(Email, 'a@.'));
		// a run of dots inside the domain is not at its edge
		assert.ok(is(Email, 'a@b..c'));
		assert.ok(is(Email, 'a@b.c.d'));
	});

	test('enforces the length bound', () => {
		// 254 ASCII chars total: a 242-char local + "@example.com" (12).
		const at_max = `${'a'.repeat(EMAIL_LENGTH_MAX - 12)}@example.com`;
		assert.strictEqual(at_max.length, EMAIL_LENGTH_MAX);
		assert.ok(is(Email, at_max));
		const over_max = `${'a'.repeat(EMAIL_LENGTH_MAX - 11)}@example.com`;
		assert.strictEqual(over_max.length, EMAIL_LENGTH_MAX + 1);
		assert.ok(!is(Email, over_max));

		// The bound is UTF-8 BYTES (RFC 5321 octets), matching the Rust spine's
		// `s.len()`, not JS's UTF-16 `.length`. `\u00fc` (ü) is 2 bytes / 1 code
		// unit, so 122×ü is 256 bytes but only 134 code units: under 254
		// `.length` (a code-unit `.max(254)` would wrongly accept it) yet over the
		// 254-byte bound, so both spines must reject it.
		const mb_at_max = `${'\u00fc'.repeat(121)}@example.com`;
		assert.strictEqual(new TextEncoder().encode(mb_at_max).length, EMAIL_LENGTH_MAX);
		assert.ok(mb_at_max.length < EMAIL_LENGTH_MAX);
		assert.ok(is(Email, mb_at_max));
		const mb_over = `${'\u00fc'.repeat(122)}@example.com`;
		assert.strictEqual(new TextEncoder().encode(mb_over).length, EMAIL_LENGTH_MAX + 2);
		assert.ok(mb_over.length < EMAIL_LENGTH_MAX);
		assert.ok(!is(Email, mb_over));
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
		assert.strictEqual(parse_or_throw(Email, 'User@Example.com'), 'User@Example.com');
		assert.strictEqual(parse_or_throw(Email, 'ADMIN@EXAMPLE.COM'), 'ADMIN@EXAMPLE.COM');
		assert.strictEqual(parse_or_throw(Email, 'Mixed.Case+Tag@Foo.Bar'), 'Mixed.Case+Tag@Foo.Bar');
	});

	test('rejects whitespace anywhere (surrounding and internal, no trim)', () => {
		// Whitespace-bearing addresses fail the `[^\s\u0085@]` character class rather
		// than being silently trimmed — surrounding (the no-transform contract,
		// same intent as the case-preservation test) AND internal. Mirrors the
		// Rust `is_valid_email`, which rejects `White_Space ∪ {U+FEFF}`, so
		// storage is verbatim on both spines.
		assert.ok(!is(Email, ' user@example.com')); // leading
		assert.ok(!is(Email, 'user@example.com ')); // trailing
		assert.ok(!is(Email, 'us er@example.com')); // internal (local)
		assert.ok(!is(Email, 'user@exa mple.com')); // internal (domain)
		assert.ok(!is(Email, 'user@e\tx.com')); // tab
		assert.ok(!is(Email, 'a\u0085b@c.d')); // NEL (U+0085)
		assert.ok(!is(Email, 'a\ufeffb@c.d')); // BOM/ZWNBSP (U+FEFF)
	});

	test('checks the length bound first, so the regex never reads an address past it', () => {
		const issues_of = (input: string) => {
			const result = parse(Email, input);
			return result.ok ? [] : result.issues.map((i) => ({ kind: i.kind, message: i.message }));
		};
		const length_issue = [{ kind: 'max_length', message: EMAIL_LENGTH_MESSAGE }];
		// off the grammar and past the bound: the length issue alone
		assert.deepStrictEqual(issues_of('a'.repeat(EMAIL_LENGTH_MAX + 1)), length_issue);
		assert.deepStrictEqual(issues_of(`a@b${'.'.repeat(1_000_000)}@`), length_issue);
		// on the grammar and past the bound
		assert.deepStrictEqual(issues_of(`${'a'.repeat(EMAIL_LENGTH_MAX)}@b.c`), length_issue);
		// off the grammar within the bound: the grammar issue
		assert.deepStrictEqual(
			issues_of('a@b').map((i) => i.kind),
			['regex']
		);
	});
});

describe('EMAIL_REGEX', () => {
	test('gives the verdict of its quadratic spelling and of the Rust rule on every short string', () => {
		const differ: Array<string> = [];
		let accepted = 0;
		const visit = (s: string) => {
			const verdict = EMAIL_REGEX.test(s);
			if (verdict) accepted++;
			if (verdict !== EMAIL_REGEX_REFERENCE.test(s) || verdict !== is_email_by_rule(s)) {
				differ.push(s);
			}
		};
		// the structural characters, and with them each class of whitespace the
		// grammar refuses: ASCII, NEL (U+0085), BOM (U+FEFF) and LS (U+2028)
		each_string(['a', '.', '@'], 10, visit);
		each_string(['a', '.', '@', ' ', '\u0085', '\ufeff', '\u2028'], 6, visit);
		assert.deepStrictEqual(differ, []);
		assert.ok(accepted > 0);
	});

	test('runs in time linear in the input on the shapes that make the quadratic spelling backtrack', () => {
		// The quadratic spelling takes about a second on 40,000 characters of
		// these shapes and grows with the square, so about half a minute on each
		// of these, where the linear one takes under a millisecond: the bound is
		// orders of magnitude from both, so neither a slow machine nor a busy one
		// flips it, and a quadratic regression fails within a minute instead of
		// hanging the run.
		const n = 200_000;
		const inputs = [
			`a@b${'.'.repeat(n)}@`,
			`a@b${'.'.repeat(n)} `,
			`a@b${'.'.repeat(n)}`,
			`a@b.${'.'.repeat(n)}`,
			`a@${'b.'.repeat(n / 2)} `,
			`a@${'b.'.repeat(n / 2)}.`,
			`a@${'.a'.repeat(n / 2)} `,
			`${'a'.repeat(n)}@b.c `
		];
		for (const input of inputs) {
			const start = performance.now();
			EMAIL_REGEX.test(input);
			const elapsed = performance.now() - start;
			assert.ok(elapsed < 1000, `took ${elapsed} ms on ${JSON.stringify(input.slice(0, 8))}…`);
		}
	});
});
