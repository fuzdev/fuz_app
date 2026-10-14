/**
 * Reusable validator-schema primitives — `bounded_string`, `Username`,
 * `UsernameProvided`, `Email`. Lives at the top level (not inside `auth/` or `http/`) because
 * these shapes don't depend on or imply any domain — accounts hold a
 * username and email, but invites, password resets, future cell-sharing,
 * and other surfaces all reach for the same primitives without going
 * through auth.
 *
 * Split out from `auth/account_schema.ts` so the auth module shrinks to
 * entity types + client-safe JSON shapes (its real responsibility) and
 * non-auth consumers can import these primitives without dragging the
 * auth domain along. Future cross-domain primitives (phone, url, slug)
 * land here too.
 *
 * @module
 */

import { z } from 'zod';

// TODO consider `.brand()` on Username and Email for compile-time safety

/** Length bounds for `bounded_string`, in UTF-16 code units. */
export interface BoundedStringOptions {
	/** Shortest string admitted. Omit for no lower bound. */
	min?: number;
	/** Longest string admitted. */
	max: number;
	/** Message for the over-`max` issue, in place of Zod's default. */
	max_message?: string;
}

/**
 * A string schema whose length is bounded in UTF-16 code units — what
 * `String.length` measures, and what the Rust spine counts
 * (`encode_utf16().count()`), so an astral-plane character costs two on both.
 * Every `.min()` / `.max()` length bound on a wire string in the package is
 * built here, bar a bare `.min(1)`, which reads the same in either count.
 *
 * Zod's `.min()` / `.max()` alone don't pin the unit: depending on the
 * installed Zod they count code units or Unicode code points, and the peer
 * range admits both. The schema still carries them — they are what puts
 * `minLength` / `maxLength` in the generated JSON Schema — and a check beside
 * them settles the verdict on `String.length`: it adds the over-`max` or
 * under-`min` issue when Zod raised none, and withdraws one Zod raised for a
 * string that is within the bound in units. The issue it adds has the fields
 * of Zod's own and, like Zod's, lets the checks chained after it run, so a
 * refusal reads the same whichever count Zod used.
 *
 * Returns a plain `ZodString`, so format checks, `.brand()`, `.nullish()` and
 * `.meta()` chain as usual. Don't chain a further `.min()` / `.max()` — pass
 * the bound here.
 *
 * @param options - the bounds, in UTF-16 code units
 * @returns the bounded string schema
 */
export const bounded_string = ({ min, max, max_message }: BoundedStringOptions): z.ZodString => {
	let schema = z.string();
	if (min !== undefined) schema = schema.min(min);
	schema = max_message === undefined ? schema.max(max) : schema.max(max, max_message);
	return schema.check((ctx) => {
		const { length } = ctx.value;
		const { issues } = ctx;
		const too_big = issues.findIndex(
			(i) => i.code === 'too_big' && i.origin === 'string' && i.maximum === max
		);
		if (length > max) {
			if (too_big === -1) {
				issues.push({
					origin: 'string',
					code: 'too_big',
					maximum: max,
					inclusive: true,
					input: ctx.value,
					// as on Zod's own length issues: the checks chained after still run
					continue: true,
					// `path` ahead of `message`, the key order of Zod's finalized issue
					...(max_message !== undefined && { path: [], message: max_message })
				});
			}
		} else if (too_big !== -1) {
			issues.splice(too_big, 1);
		}
		if (min === undefined) return;
		const too_small = issues.findIndex(
			(i) => i.code === 'too_small' && i.origin === 'string' && i.minimum === min
		);
		if (length < min) {
			if (too_small === -1) {
				issues.push({
					origin: 'string',
					code: 'too_small',
					minimum: min,
					inclusive: true,
					input: ctx.value,
					continue: true
				});
			}
		} else if (too_small !== -1) {
			issues.splice(too_small, 1);
		}
	});
};

/** Minimum username length (must have start + middle + end characters). */
export const USERNAME_LENGTH_MIN = 3;

/** Maximum username length (matches GitHub's limit). The grammar is ASCII, so units and characters agree. */
export const USERNAME_LENGTH_MAX = 39;

/** Maximum length for username input on login/lookup, in UTF-16 code units, measured before trimming — more permissive than `USERNAME_LENGTH_MAX` for forward-compatibility if the creation limit is raised. */
export const USERNAME_PROVIDED_LENGTH_MAX = 255;

/**
 * Username for account creation — starts with letter, alphanumeric/dash/underscore middle, ends with alphanumeric. No @ or . allowed.
 *
 * Canonicalized to lowercase at parse time. The regex rejects whitespace
 * outright, so `.trim()` is unnecessary here. Storage is canonical across
 * every creation site (bootstrap, signup, admin-create, invite acceptance)
 * because the schema is the single source of truth — eliminates the
 * per-caller `trim().toLowerCase()` ritual and keeps the
 * `LOWER(username) = LOWER($1)` lookup contract simple.
 */
export const Username = bounded_string({ min: USERNAME_LENGTH_MIN, max: USERNAME_LENGTH_MAX })
	.regex(/^[a-zA-Z][0-9a-zA-Z_-]*[0-9a-zA-Z]$/)
	.transform((s) => s.toLowerCase());
export type Username = z.infer<typeof Username>;

/**
 * Username submitted for login or lookup — minimal validation for forward-compatibility if format rules change.
 *
 * Canonicalized via `.trim().toLowerCase()` at parse time so login's
 * per-account rate-limit key and DB lookup see a uniform value
 * regardless of casing or surrounding whitespace. Mirrors the storage
 * canonicalization on `Username` so submission and storage agree.
 *
 * The trailing `.refine` rejects a whitespace-only identifier: `.min(1)`
 * runs on the raw string (so `"   "` passes it), and without the post-trim
 * check the value would canonicalize to `""` and fall through to a
 * lookup-miss 401 instead of a 400 — an empty identifier is malformed
 * input, not a wrong credential. Keeps the Rust spine's
 * `account_login` (which rejects empty-after-trim) in parity.
 */
export const UsernameProvided = bounded_string({ min: 1, max: USERNAME_PROVIDED_LENGTH_MAX })
	.transform((s) => s.trim().toLowerCase())
	.refine((s) => s.length > 0, { message: 'Username must not be empty after trimming whitespace' });
export type UsernameProvided = z.infer<typeof UsernameProvided>;

/**
 * Maximum email length in **bytes** — RFC 5321 §4.5.3.1.3 path-length limit
 * (the limit is octets). `Email` bounds the UTF-8 byte length, matching the
 * Rust spine's `s.len()` check; for an all-ASCII address bytes == characters.
 */
export const EMAIL_LENGTH_MAX = 254;

/**
 * Loose email shape `local@domain.tld`: a non-empty local part, exactly one
 * `@`, a domain with an interior dot (a non-empty label on each side), and
 * no whitespace. Accepts `a@b.c` (single-char TLDs are fine) and
 * `user+tag@a.co`; rejects `notanemail`, `@x.com`, `user@`, `user@host`, and
 * any whitespace.
 *
 * The negated class excludes `\s` **plus** U+0085 (NEL): JS's `\s` omits
 * U+0085 but Unicode `White_Space` (Rust's `char::is_whitespace`) includes
 * it, so excluding it keeps the whitespace set identical across the twins.
 * (The Rust side correspondingly also rejects U+FEFF, which JS `\s` treats as
 * whitespace but Unicode `White_Space` does not — so both spines reject
 * exactly `White_Space ∪ {U+FEFF}`.)
 */
const EMAIL_REGEX = /^[^\s\u0085@]+@[^\s\u0085@]+\.[^\s\u0085@]+$/;

/** UTF-8 encoder for the `EMAIL_LENGTH_MAX` byte (octet) bound. */
const utf8_encoder = new TextEncoder();

/**
 * Email validation. Lives here rather than `@fuzdev/fuz_util` because every
 * current consumer pairs it with `Username` (signup, invites, audit log) —
 * keeping the two together avoids a cross-package import for the
 * identity-primitive bundle. Promote to fuz_util if a non-identity consumer
 * surfaces.
 *
 * Deliberately permissive — a structural shape check (`EMAIL_REGEX` plus the
 * `EMAIL_LENGTH_MAX` byte bound), not RFC 5322 conformance or deliverability
 * (real delivery is proven by a confirmation email). Replaces Zod's stricter
 * `z.email()` so the rule is one explicit regex the Rust spine's
 * `is_valid_email` mirrors; `z.email()`'s internal regex (2+ char TLD, no
 * consecutive dots) was brittle to keep in cross-impl parity and rejected
 * addresses like `a@b.c`. The length bound is the UTF-8 **byte** count (RFC
 * 5321 measures octets), so a multibyte address is bounded identically to the
 * Rust spine's `s.len()` rather than diverging on JS's UTF-16 `.length`. No
 * transform: case is preserved and surrounding whitespace is rejected (not
 * trimmed), so storage is verbatim and the case-insensitive lookup rides the
 * DB-side `LOWER(email)`.
 */
export const Email = z
	.string()
	.regex(EMAIL_REGEX)
	// `s.length` (UTF-16 units) is a cheap upper bound that short-circuits the
	// `encode` on absurd inputs: a valid (<= 254-byte) address is necessarily
	// <= 254 code units, so this never rejects one — the byte count is the real
	// RFC-5321 octet bound, matching the Rust spine's `s.len()`.
	.refine(
		(s) => s.length <= EMAIL_LENGTH_MAX && utf8_encoder.encode(s).length <= EMAIL_LENGTH_MAX,
		{
			message: `Email must be at most ${EMAIL_LENGTH_MAX} bytes`
		}
	);
export type Email = z.infer<typeof Email>;
