/**
 * Reusable validator-schema primitives — `bounded_string`, `Username`,
 * `Email`, the branded `Uuid` and `Datetime` with their factories, and the
 * hash schema `FactHashSchema`. Lives at
 * the top level (not inside `auth/` or `http/`) because these shapes don't
 * depend on or imply any domain — accounts hold a username and email, but
 * invites, password resets, cells, and other surfaces all reach for the same
 * primitives without going through auth.
 *
 * Split out from `auth/account_schema.ts` so the auth module shrinks to
 * entity types + client-safe JSON shapes (its real responsibility) and
 * non-auth consumers can import these primitives without dragging the
 * auth domain along. Future cross-domain primitives (phone, slug) land
 * here too; a URL is `Url` from `@fuzdev/fuz_util/url.ts`.
 *
 * Client-safe: nothing here imports `@fuzdev/blake3-wasm`, so wire schemas
 * that validate a hash don't pull the WASM binary into a bundle.
 *
 * @module
 */

import { z } from 'zod';
import type { Branded } from '@fuzdev/fuz_schema/schema.ts';
import { FACT_HASH_EXACT, type FactHash } from '@fuzdev/fuz_util/hash_schemas.ts';

// TODO consider `.brand()` on Username and Email for compile-time safety

/** Length bounds for `bounded_string`, in UTF-16 code units. */
export interface BoundedStringOptions {
	/** Shortest string admitted. Omit for no lower bound. */
	min?: number;
	/** Longest string admitted. */
	max: number;
	/** Message for the over-`max` issue, in place of the schema library's default. */
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
export const bounded_string = (options: BoundedStringOptions): z.ZodString => {
	const { min, max, max_message } = options;
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

/**
 * The creation username's grammar: a letter, then letters, digits, `_` or
 * `-`, ending in a letter or digit. ASCII, so it needs at least two
 * characters, and `Username` bounds the length beside it.
 */
export const USERNAME_REGEX = /^[a-zA-Z][0-9a-zA-Z_-]*[0-9a-zA-Z]$/;

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
	.regex(USERNAME_REGEX)
	.transform((s) => s.toLowerCase());
export type Username = z.infer<typeof Username>;

/**
 * Maximum email length in **bytes** — RFC 5321 §4.5.3.1.3 path-length limit
 * (the limit is octets). `Email` bounds the UTF-8 byte length, matching the
 * Rust spine's `s.len()` check; for an all-ASCII address bytes == characters.
 */
export const EMAIL_LENGTH_MAX = 254;

/**
 * Loose email shape `local@domain.tld`: a non-empty local part, exactly one
 * `@`, a domain that holds a `.` and neither starts nor ends with one, and
 * no whitespace. Accepts `a@b.c` (single-char TLDs are fine), `a@b..c` and
 * `user+tag@a.co`; rejects `notanemail`, `@x.com`, `user@`, `user@host`,
 * `a@.b.c`, `a@b.c.`, and any whitespace. The Rust spine's `is_valid_email`
 * is the same rule.
 *
 * The negated class excludes `\s` **plus** U+0085 (NEL): JS's `\s` omits
 * U+0085 but Unicode `White_Space` (Rust's `char::is_whitespace`) includes
 * it, so excluding it keeps the whitespace set identical across the twins.
 * (The Rust side correspondingly also rejects U+FEFF, which JS `\s` treats as
 * whitespace but Unicode `White_Space` does not — so both spines reject
 * exactly `White_Space ∪ {U+FEFF}`.)
 *
 * Linear in the input's length: the `@` can match only the first `@`, and the
 * `\.` only the domain's first `.`, since the classes before each exclude it,
 * so the tail after the `\.` is scanned once. The domain spelled
 * `[^\s\u0085@.][^\s\u0085@]*\.[^\s\u0085@]*[^\s\u0085@.]`, the same
 * language, is quadratic: it tries every `.` as the split.
 */
export const EMAIL_REGEX = /^[^\s\u0085@]+@[^\s\u0085@.]+\.[^\s\u0085@]*[^\s\u0085@.]$/;

/** The message of an email over `EMAIL_LENGTH_MAX` bytes, on either schema library's `Email`. */
export const EMAIL_LENGTH_MESSAGE = `Email must be at most ${EMAIL_LENGTH_MAX} bytes`;

/** UTF-8 encoder for the `EMAIL_LENGTH_MAX` byte (octet) bound. */
const utf8_encoder = new TextEncoder();

/**
 * Whether `s` is at most `EMAIL_LENGTH_MAX` bytes in UTF-8, the bound both
 * `Email` schemas check.
 *
 * `s.length` (UTF-16 units) is a cheap upper bound that short-circuits the
 * `encode` on absurd inputs: a valid (<= 254-byte) address is necessarily
 * <= 254 code units, so it never refuses one — the byte count is the real
 * RFC-5321 octet bound, matching the Rust spine's `s.len()`.
 *
 * @param s - the address
 * @returns `true` when the address is within the byte bound
 */
export const is_email_within_length_max = (s: string): boolean =>
	s.length <= EMAIL_LENGTH_MAX && utf8_encoder.encode(s).length <= EMAIL_LENGTH_MAX;

/**
 * Email validation. Every current consumer pairs it with `Username` (signup,
 * invites, audit log), so the two live together with the other Zod
 * primitives.
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
 *
 * The byte bound runs first and aborts, so an address past it gets the
 * length issue alone and is never read by the regex.
 */
export const Email = z
	.string()
	.refine(is_email_within_length_max, { message: EMAIL_LENGTH_MESSAGE, abort: true })
	.regex(EMAIL_REGEX);
export type Email = z.infer<typeof Email>;

/** Returns a new random (v4) `Uuid`. */
export const create_uuid = (): Uuid => crypto.randomUUID() as Uuid;

/**
 * The UUID grammar of RFC 9562, in either case: five groups of hex digits,
 * 8-4-4-4-12, with a version from 1 to 8 and the RFC's variant, or the nil or
 * the max UUID. It is `z.uuid()`'s own but for the max UUID, which `z.uuid()`
 * spells in lowercase only, where RFC 9562 §4 reads a UUID case-insensitively.
 * The same source as the pattern fuz_schema's `uuid` renders to JSON Schema,
 * which a test holds it to, and the grammar of the Rust spine's
 * `is_valid_uuid`.
 */
const UUID_REGEX =
	/^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$/;

/**
 * Branded UUID schema. Accepts either case and outputs lowercase — the form
 * Postgres renders a `uuid` in and every id the server mints — so a parsed id
 * compares equal to the same id read back from the database. The Rust spine
 * canonicalizes the same way, and its grammar is this one, the fuz_schema
 * twin's in `primitive_schemas_fuz.ts`: `z.uuid()` with the max UUID taken in
 * any case. Issues and JSON Schema keep `format: 'uuid'`; only the `pattern`
 * differs from a bare `z.uuid()`'s, rendered or on a Zod issue (the wire
 * issue drops it).
 *
 * `pattern` is a `$ZodUUIDDef` field that `z.uuid()` honors (its default
 * applies only when none is given) but whose public params type omits it,
 * hence the cast on the params.
 *
 * `.toLowerCase()` rather than `.transform()`: an overwrite keeps the output
 * type and stays invisible to `z.toJSONSchema`, where a transform would leave
 * no input schema to render.
 *
 * The output type is fuz_schema's `Branded<string, 'Uuid'>`, the twin's, by a
 * cast as on `FactHashSchema`: Zod's `.brand('Uuid')` would output Zod's own
 * brand, which a fuz_schema `Uuid` isn't assignable to.
 */
export const Uuid: z.ZodUUID & z.ZodType<Branded<string, 'Uuid'>, string> = z
	.uuid({ pattern: UUID_REGEX } as z.core.$ZodUUIDParams)
	.toLowerCase() as z.ZodUUID & z.ZodType<Branded<string, 'Uuid'>, string>;
export type Uuid = z.infer<typeof Uuid>;

/** `Uuid` that defaults to a fresh `create_uuid()` when the input is `undefined`. */
export const UuidWithDefault = Uuid.default(create_uuid);
export type UuidWithDefault = z.infer<typeof UuidWithDefault>;

/**
 * Branded datetime schema, zod's default `z.iso.datetime()`: an RFC 3339 date
 * and time in UTC with a real calendar date, `Z` and no offset, and a fraction
 * of any length or none. Zod 4.6 requires the seconds; earlier zod 4, which
 * the `zod` peer range admits, also takes `HH:MMZ`. fuz_schema's
 * `iso_datetime` is this grammar with the seconds required and the fraction
 * capped at 9 digits.
 */
export const Datetime = z.iso.datetime().brand('Datetime');
export type Datetime = z.infer<typeof Datetime>;

/** Returns an ISO 8601 datetime string for the current time. */
export const get_datetime_now = (): Datetime => new Date().toISOString() as Datetime;

/** `Datetime` that defaults to `get_datetime_now()` when the input is `undefined`. */
export const DatetimeNow = Datetime.default(get_datetime_now);
export type DatetimeNow = z.infer<typeof DatetimeNow>;

/**
 * Wire-form schema for a `blake3:`-prefixed fact hash, whose output is
 * `FactHash` from `@fuzdev/fuz_util/hash_schemas.ts` — the type
 * `fact_hash_bytes`, `fact_hash_stream`, and `FactStore` use — so a parsed
 * value passes straight to them. Client-side (cell payloads) and server-side
 * (DB-row hashes) consumers reuse this same schema.
 *
 * The output type is a cast over a plain regex check: Zod's `.brand('FactHash')`
 * would output Zod's own brand, which doesn't fit fuz_util's fuz_schema-branded
 * `FactHash`, and a `.transform` or `z.custom` that produced the right type
 * makes `z.toJSONSchema` throw, as neither can be represented in JSON Schema.
 * The cast costs nothing at runtime and keeps the `ZodString` API and the
 * `pattern` in the generated JSON Schema, so `.meta()`, `.nullable()`, and
 * `z.array()` compose as before.
 */
export const FactHashSchema: z.ZodString & z.ZodType<FactHash, string> = z
	.string()
	.regex(FACT_HASH_EXACT) as z.ZodString & z.ZodType<FactHash, string>;
