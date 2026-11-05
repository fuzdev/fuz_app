/**
 * `@fuzdev/fuz_schema` twins of the Zod `Uuid`, `UuidWithDefault`
 * (`primitive_schemas.ts`), and `ActingActor` (`http/auth_shape.ts`), under the
 * same names, for inputs written in fuz_schema.
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
	optional,
	pipe,
	string,
	to_lower_case,
	uuid,
	with_default_fn,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

import { create_uuid } from './primitive_schemas.ts';

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
