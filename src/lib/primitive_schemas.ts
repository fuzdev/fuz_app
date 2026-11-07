/**
 * Reusable validator-schema primitives, in `@fuzdev/fuz_schema` —
 * `bounded_string`, `Username` with `UsernameCanonical` and
 * `UsernameProvided`, `Email`, the branded `Uuid` with its factory,
 * `Timestamp`, the hash schemas `FactHashSchema` and `Blake3Hash`, and
 * `ActingActor`. Lives at the top level (not inside `auth/` or `http/`)
 * because these shapes don't depend on or imply any domain — accounts hold a
 * username and email, but invites, password resets, cells, and other surfaces
 * all reach for the same primitives without going through auth. A URL is
 * `Url` from `@fuzdev/fuz_util/url.ts`.
 *
 * Client-safe: nothing here imports `@fuzdev/blake3-wasm`, so wire schemas
 * that validate a hash don't pull the WASM binary into a bundle.
 *
 * @module
 */

import { meta } from '@fuzdev/fuz_schema/meta.ts';
import {
	brand,
	check,
	iso_datetime,
	max_length,
	message,
	min_length,
	optional,
	pipe,
	regex,
	string,
	to_lower_case,
	transform,
	uuid,
	with_default_fn,
	type Infer,
	type PipeSchema
} from '@fuzdev/fuz_schema/schema.ts';
import { FACT_HASH_EXACT } from '@fuzdev/fuz_util/hash_schemas.ts';

// TODO consider `brand` on Username and Email for compile-time safety

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
 * fuz_schema's `min_length` / `max_length` read `String.length`. Every length
 * bound on a wire string in the package is built here. Its JSON Schema
 * carries `minLength` / `maxLength`; `max_message` replaces fuz_schema's
 * message on the over-`max` issue.
 *
 * @param options - the bounds, in UTF-16 code units, and the max message
 * @returns the bounded string schema
 */
export const bounded_string = (
	options: BoundedStringOptions
): PipeSchema<string, typeof string> => {
	const { min, max, max_message } = options;
	const max_step =
		max_message === undefined ? max_length(max) : message(max_length(max), max_message);
	return min === undefined ? pipe(string, max_step) : pipe(string, min_length(min), max_step);
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
 * outright, so no trim is needed. Storage is canonical across every creation
 * site (bootstrap, signup, admin-create, invite acceptance) because the
 * schema is the single source of truth — eliminates the per-caller
 * `trim().toLowerCase()` ritual and keeps the `LOWER(username) = LOWER($1)`
 * lookup contract simple. A string outside the bounds and off the grammar
 * gets the length issue alone.
 */
export const Username = pipe(
	bounded_string({ min: USERNAME_LENGTH_MIN, max: USERNAME_LENGTH_MAX }),
	regex(USERNAME_REGEX),
	to_lower_case
);
export type Username = Infer<typeof Username>;

/**
 * A username's canonical grammar, `USERNAME_REGEX` in lowercase: a lowercase
 * letter, then lowercase letters, digits, `_` or `-`, ending in a lowercase
 * letter or digit. What `Username` outputs, and what an `account` row holds
 * (its `account_username_lowercase` CHECK).
 */
export const USERNAME_CANONICAL_REGEX = /^[a-z][0-9a-z_-]*[0-9a-z]$/;

/**
 * A username as an account row holds it, the `username` of an output: the
 * bounds of `Username` and `USERNAME_CANONICAL_REGEX`, no transform. A
 * username in any other case fails, where `Username` lowercases it.
 */
export const UsernameCanonical = pipe(
	bounded_string({ min: USERNAME_LENGTH_MIN, max: USERNAME_LENGTH_MAX }),
	regex(USERNAME_CANONICAL_REGEX)
);
export type UsernameCanonical = Infer<typeof UsernameCanonical>;

/**
 * Username submitted for login or lookup — minimal validation, for
 * forward-compatibility if the creation grammar changes: at least one and at
 * most `USERNAME_PROVIDED_LENGTH_MAX` UTF-16 code units, measured before
 * trimming, holding a character that isn't whitespace.
 *
 * Canonicalized to `.trim().toLowerCase()` at parse time, so login's
 * per-account rate-limit key and its lookup see one value whatever the casing
 * or surrounding whitespace, as `Username` canonicalizes what is stored.
 *
 * A whitespace-only identifier is refused, not canonicalized to `""` and left
 * to fall through to a lookup-miss 401: an empty identifier is malformed
 * input, not a wrong credential, and the Rust spine's `account_login` refuses
 * it too. JS `\s` is exactly the set `trim` removes (ECMA-262's WhiteSpace and
 * LineTerminator), so the `regex` ahead of the transform refuses what would
 * trim to nothing.
 */
export const UsernameProvided = pipe(
	bounded_string({ min: 1, max: USERNAME_PROVIDED_LENGTH_MAX }),
	message(regex(/\S/), 'Username must not be empty after trimming whitespace'),
	transform((s) => s.trim().toLowerCase())
);
export type UsernameProvided = Infer<typeof UsernameProvided>;

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

/** The message of an email over `EMAIL_LENGTH_MAX` bytes, on `Email`. */
export const EMAIL_LENGTH_MESSAGE = `Email must be at most ${EMAIL_LENGTH_MAX} bytes`;

/** UTF-8 encoder for the `EMAIL_LENGTH_MAX` byte (octet) bound. */
const utf8_encoder = new TextEncoder();

/**
 * Whether `s` is at most `EMAIL_LENGTH_MAX` bytes in UTF-8, the bound `Email`
 * checks.
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
 * invites, audit log), so the two live together with the other primitives.
 *
 * Deliberately permissive — a structural shape check (`EMAIL_REGEX` plus the
 * `EMAIL_LENGTH_MAX` byte bound), not RFC 5322 conformance or deliverability
 * (real delivery is proven by a confirmation email). The rule is one explicit
 * regex the Rust spine's `is_valid_email` mirrors, looser than grammars
 * requiring a 2+ char TLD and no consecutive dots, which reject addresses like
 * `a@b.c`. The length bound is the UTF-8 **byte** count (RFC 5321
 * measures octets), so a multibyte address is bounded identically to the
 * Rust spine's `s.len()`. No transform: case is preserved and surrounding
 * whitespace is rejected (not trimmed), so storage is verbatim and the
 * case-insensitive lookup rides the DB-side `LOWER(email)`.
 *
 * The `max_length` ahead of the grammar refuses a string past the bound in
 * UTF-16 code units, which is past it in bytes too, before the regex reads
 * it, and the `check` after it the multibyte address within the units but
 * past the bytes, both with `EMAIL_LENGTH_MESSAGE`. Its JSON Schema carries
 * the bound as `maxLength`.
 */
export const Email = pipe(
	string,
	message(max_length(EMAIL_LENGTH_MAX), EMAIL_LENGTH_MESSAGE),
	regex(EMAIL_REGEX),
	message(check(is_email_within_length_max), EMAIL_LENGTH_MESSAGE)
);
export type Email = Infer<typeof Email>;

/** Returns a new random (v4) `Uuid`. */
export const create_uuid = (): Uuid => crypto.randomUUID() as Uuid;

/**
 * The UUID grammar of RFC 9562, in either case: five groups of hex digits,
 * 8-4-4-4-12, with a version from 1 to 8 and the RFC's variant, or the nil or
 * the max UUID, read case-insensitively as RFC 9562 §4 reads a UUID. The same
 * source as the pattern fuz_schema's `uuid` renders to JSON Schema, which a
 * test holds it to, and the grammar of the Rust spine's `is_valid_uuid`.
 */
export const UUID_REGEX =
	/^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$/;

/**
 * Branded UUID schema: a UUID of RFC 9562 in either case, fuz_schema's `uuid`
 * (whose grammar is `UUID_REGEX`), output in lowercase — the form Postgres renders a `uuid` in and every id
 * the server mints — so a parsed id compares equal to the same id read back
 * from the database. The Rust spine canonicalizes the same way. The brand
 * goes outside the `to_lower_case`, which outputs a new string.
 */
export const Uuid = brand(pipe(string, uuid, to_lower_case), 'Uuid');
export type Uuid = Infer<typeof Uuid>;

/** `Uuid` that defaults to a fresh `create_uuid()` when the input is `undefined`. */
export const UuidWithDefault = with_default_fn(Uuid, create_uuid);
export type UuidWithDefault = Infer<typeof UuidWithDefault>;

/**
 * A timestamp on the wire: a date and time of RFC 3339 in UTC, fuz_schema's
 * `iso_datetime`, which both spines' `YYYY-MM-DDTHH:MM:SSZ`
 * (`iso8601_timestamp_column`) and a `toISOString()` stamp satisfy. Not
 * branded.
 */
export const Timestamp = pipe(string, iso_datetime);
export type Timestamp = Infer<typeof Timestamp>;

/**
 * A `blake3:`-prefixed fact hash on the wire: `FACT_HASH_EXACT`, its output
 * `FactHash` from `@fuzdev/fuz_util/hash_schemas.ts` — the type
 * `fact_hash_bytes`, `fact_hash_stream`, and `FactStore` take — so a parsed
 * value passes straight to them. Client-side (cell payloads) and server-side
 * (DB-row hashes) consumers reuse this same schema. Its JSON Schema is the
 * `pattern`.
 */
export const FactHashSchema = brand(pipe(string, regex(FACT_HASH_EXACT)), 'FactHash');

/** A BLAKE3 hex hash's grammar: 64 lowercase hex characters (256-bit output). */
export const BLAKE3_HASH_REGEX = /^[0-9a-f]{64}$/;

/** The message of a string off `BLAKE3_HASH_REGEX`. */
export const BLAKE3_HASH_MESSAGE = 'Expected a 64-character lowercase hex blake3 hash';

/**
 * A BLAKE3 hex hash: `BLAKE3_HASH_REGEX`, whose issue carries
 * `BLAKE3_HASH_MESSAGE`. A value that is no string gets fuz_schema's message.
 */
export const Blake3Hash = pipe(string, message(regex(BLAKE3_HASH_REGEX), BLAKE3_HASH_MESSAGE));
export type Blake3Hash = Infer<typeof Blake3Hash>;

/** The `description` of `ActingActor`. */
export const ACTING_ACTOR_DESCRIPTION =
	'Actor on the authenticated account that this request acts as. Omit on single-actor accounts; required on multi-actor.';

/**
 * `acting` field shared by every input that needs the caller's acting actor.
 * Declaring `acting: ActingActor` on a route or action input signals to the
 * dispatcher's authorization phase to resolve an actor against the
 * authenticated account: it runs `resolve_acting_actor`, builds the
 * actor-bound `RequestContext`, and loads role_grants before auth guards fire.
 *
 * Resolution rules: omitted + 1 actor → use it; omitted + multiple actors →
 * `actor_required` with the available list; supplied + on the account → use
 * it; supplied + foreign actor → `actor_not_on_account`.
 *
 * Account-grain routes — input doesn't declare `acting` and auth doesn't
 * require role_grants — skip resolution entirely; their `RequestContext.actor`
 * is `null` and the audit envelope's `actor_id` stays null.
 *
 * Paired with `RouteAuth` (`http/auth_shape.ts`) by registry-time invariant
 * 2: `auth.actor !== 'none'` ⟺ input (or query, on REST GETs) declares
 * `acting?: ActingActor`. The dispatcher finds it by reference
 * (`input_schema_declares_acting`), so an input declares this export, not a
 * copy of it.
 */
export const ActingActor = meta(optional(Uuid), { description: ACTING_ACTOR_DESCRIPTION });
export type ActingActor = Infer<typeof ActingActor>;
