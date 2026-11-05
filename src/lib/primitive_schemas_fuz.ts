/**
 * `@fuzdev/fuz_schema` twins of the Zod `bounded_string`, `Username`,
 * `Email`, `Uuid`, `UuidWithDefault` (`primitive_schemas.ts`), and
 * `ActingActor` (`http/auth_shape.ts`), under the same names, for schemas
 * written in fuz_schema.
 *
 * The output type is shared: the Zod `Uuid` outputs fuz_schema's
 * `Branded<string, 'Uuid'>` too, so a value parsed by either twin goes where
 * the other's is taken.
 *
 * Both twins have one grammar, RFC 9562's read case-insensitively as its §4
 * says, the max UUID included, and the Rust spine's: every input gets the same
 * verdict and output from both, and their JSON Schema is the same.
 *
 * The exports are `@nodocs` while the Zod schemas of the same names stay, as
 * the docs build refuses two exports of one name.
 *
 * @module
 */

import { meta } from '@fuzdev/fuz_schema/meta.ts';
import {
	brand,
	check,
	max_length,
	message,
	min_length,
	optional,
	pipe,
	regex,
	string,
	to_lower_case,
	uuid,
	with_default_fn,
	type Infer,
	type PipeSchema
} from '@fuzdev/fuz_schema/schema.ts';

import {
	create_uuid,
	EMAIL_LENGTH_MAX,
	EMAIL_LENGTH_MESSAGE,
	EMAIL_REGEX,
	is_email_within_length_max,
	USERNAME_LENGTH_MAX,
	USERNAME_LENGTH_MIN,
	USERNAME_REGEX,
	type BoundedStringOptions
} from './primitive_schemas.ts';

/**
 * A string schema whose length is bounded in UTF-16 code units, the twin of
 * the Zod `bounded_string`: fuz_schema's `min_length` / `max_length` read
 * `String.length`, the unit the Rust spine counts too, so no check beside them
 * is needed. Its JSON Schema carries `minLength` / `maxLength` as the Zod
 * one's does; `max_message` replaces fuz_schema's message on the over-`max`
 * issue.
 *
 * @param options - the bounds, in UTF-16 code units, and the max message
 * @returns the bounded string schema
 * @nodocs
 */
export const bounded_string = (
	options: BoundedStringOptions
): PipeSchema<string, typeof string> => {
	const { min, max, max_message } = options;
	const max_step =
		max_message === undefined ? max_length(max) : message(max_length(max), max_message);
	return min === undefined ? pipe(string, max_step) : pipe(string, min_length(min), max_step);
};

/**
 * Username for account creation, the twin of the Zod `Username`: the same
 * bounds and grammar, output in lowercase. Every input gets the same verdict
 * and output from both; a string outside the bounds and off the grammar gets
 * the length issue alone, where Zod adds the grammar issue after it.
 *
 * @nodocs
 */
export const Username = pipe(
	bounded_string({ min: USERNAME_LENGTH_MIN, max: USERNAME_LENGTH_MAX }),
	regex(USERNAME_REGEX),
	to_lower_case
);
/** @nodocs */
export type Username = Infer<typeof Username>;

/**
 * Email validation, the twin of the Zod `Email`: `EMAIL_REGEX` and at most
 * `EMAIL_LENGTH_MAX` UTF-8 bytes, no transform. The `max_length` ahead of the
 * grammar refuses a string past the bound in UTF-16 code units, which is past
 * it in bytes too, before the regex reads it, and the `check` after it the
 * multibyte address within the units but past the bytes, both with
 * `EMAIL_LENGTH_MESSAGE`. Every input gets the same verdict and output from
 * both; a string past the bound in code units gets the length issue as a
 * `max_length`, where Zod gives a `check`, and one within the bound in code
 * units but past it in bytes and off the grammar gets the grammar issue, where
 * Zod gives the length one.
 *
 * @nodocs
 */
export const Email = pipe(
	string,
	message(max_length(EMAIL_LENGTH_MAX), EMAIL_LENGTH_MESSAGE),
	regex(EMAIL_REGEX),
	message(check(is_email_within_length_max), EMAIL_LENGTH_MESSAGE)
);
/** @nodocs */
export type Email = Infer<typeof Email>;

/**
 * Branded UUID schema: a UUID of RFC 9562 in either case, output in
 * lowercase, the form Postgres renders a `uuid` in and every id the server
 * mints. The brand goes outside the `to_lower_case`, which outputs a new
 * string.
 *
 * @nodocs
 */
export const Uuid = brand(pipe(string, uuid, to_lower_case), 'Uuid');
/** @nodocs */
export type Uuid = Infer<typeof Uuid>;

/**
 * `Uuid` that defaults to a fresh `create_uuid()` when the input is `undefined`.
 *
 * @nodocs
 */
export const UuidWithDefault = with_default_fn(Uuid, create_uuid);
/** @nodocs */
export type UuidWithDefault = Infer<typeof UuidWithDefault>;

/** The `description` both `ActingActor` twins carry. */
export const ACTING_ACTOR_DESCRIPTION =
	'Actor on the authenticated account that this request acts as. Omit on single-actor accounts; required on multi-actor.';

/**
 * The `acting` field of an input that needs the caller's acting actor, the
 * twin of `ActingActor` in `http/auth_shape.ts`, whose doc has the resolution
 * rules. The dispatcher finds either twin by reference, so an input declares
 * this export, not a copy of it.
 *
 * @nodocs
 */
export const ActingActor = meta(optional(Uuid), { description: ACTING_ACTOR_DESCRIPTION });
/** @nodocs */
export type ActingActor = Infer<typeof ActingActor>;
