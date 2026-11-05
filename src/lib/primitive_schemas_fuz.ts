/**
 * `@fuzdev/fuz_schema` twins of the Zod `bounded_string`, `Uuid`,
 * `UuidWithDefault` (`primitive_schemas.ts`), and `ActingActor`
 * (`http/auth_shape.ts`), under the same names, for schemas written in
 * fuz_schema.
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
	max_length,
	message,
	min_length,
	optional,
	pipe,
	string,
	to_lower_case,
	uuid,
	with_default_fn,
	type Infer,
	type PipeSchema
} from '@fuzdev/fuz_schema/schema.ts';

import { create_uuid, type BoundedStringOptions } from './primitive_schemas.ts';

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
