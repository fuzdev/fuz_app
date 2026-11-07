/**
 * The Zod forms of the primitives a consumer's Zod schema embeds: `ZodUuid`,
 * `ZodUuidWithDefault`, `ZodFactHashSchema`, `ZodUsername`, `ZodEmail`, and
 * `ZodActingActor`, each built on the grammar of its `@fuzdev/fuz_schema`
 * twin in `primitive_schemas.ts` and sharing its output type, so a value
 * parsed by either goes where the other's is taken; and the branded
 * `Datetime`, with `DatetimeNow` and `get_datetime_now`, which has no twin
 * (`Timestamp` is the wire timestamp).
 *
 * fuz_app's own schemas are fuz_schema; this module is for apps whose schemas
 * are still Zod, which the action and route layers accept. It is the one
 * fuz_app module that imports Zod at runtime, so only an importer of it loads
 * Zod.
 *
 * @module
 */

import { z } from 'zod';
import type { Branded } from '@fuzdev/fuz_schema/schema.ts';
import { FACT_HASH_EXACT, type FactHash } from '@fuzdev/fuz_util/hash_schemas.ts';

import {
	ACTING_ACTOR_DESCRIPTION,
	create_uuid,
	EMAIL_LENGTH_MESSAGE,
	EMAIL_REGEX,
	is_email_within_length_max,
	USERNAME_LENGTH_MAX,
	USERNAME_LENGTH_MIN,
	USERNAME_REGEX,
	UUID_REGEX
} from './primitive_schemas.ts';
import { register_zod_acting_actor } from './http/auth_shape.ts';

/**
 * A Zod string bounded in UTF-16 code units, `ZodUsername`'s length check.
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
 */
const zod_bounded_string = (min: number, max: number): z.ZodString =>
	z
		.string()
		.min(min)
		.max(max)
		.check((ctx) => {
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
						continue: true
					});
				}
			} else if (too_big !== -1) {
				issues.splice(too_big, 1);
			}
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

/**
 * The Zod form of `Username`: the same bounds and grammar, output in
 * lowercase. Every input gets the same verdict and output from both; a string
 * outside the bounds and off the grammar gets the grammar issue after the
 * length one, where `Username` gives the length issue alone.
 */
export const ZodUsername = zod_bounded_string(USERNAME_LENGTH_MIN, USERNAME_LENGTH_MAX)
	.regex(USERNAME_REGEX)
	.transform((s) => s.toLowerCase());
export type ZodUsername = z.infer<typeof ZodUsername>;

/**
 * The Zod form of `Email`: at most `EMAIL_LENGTH_MAX` UTF-8 bytes, then
 * `EMAIL_REGEX`, no transform. Every input gets the same verdict and output
 * from both. The byte bound runs first and aborts, so an address past it gets
 * the length issue alone, a Zod `custom` issue with `EMAIL_LENGTH_MESSAGE`,
 * and is never read by the regex; its JSON Schema is the `pattern` alone,
 * where `Email`'s adds the bound as `maxLength`.
 */
export const ZodEmail = z
	.string()
	.refine(is_email_within_length_max, { message: EMAIL_LENGTH_MESSAGE, abort: true })
	.regex(EMAIL_REGEX);
export type ZodEmail = z.infer<typeof ZodEmail>;

/**
 * The Zod form of `Uuid`: `z.uuid()` with `UUID_REGEX` as its `pattern` — the
 * max UUID in any case, as RFC 9562 §4 and the Rust spine's `is_valid_uuid`
 * read it — output in lowercase. Every input gets the same verdict and output
 * from both, and their JSON Schema is the same. Issues and JSON Schema keep
 * `format: 'uuid'`; only the `pattern` differs from a bare `z.uuid()`'s.
 *
 * `pattern` is a `$ZodUUIDDef` field that `z.uuid()` honors (its default
 * applies only when none is given) but whose public params type omits it,
 * hence the cast on the params.
 *
 * `.toLowerCase()` rather than `.transform()`: an overwrite keeps the output
 * type and stays invisible to JSON Schema, where a transform would leave no
 * input schema to render.
 *
 * The output type is fuz_schema's `Branded<string, 'Uuid'>`, `Uuid`'s, by a
 * cast: Zod's `.brand('Uuid')` would output Zod's own brand, which a
 * fuz_schema `Uuid` isn't assignable to.
 */
export const ZodUuid: z.ZodUUID & z.ZodType<Branded<string, 'Uuid'>, string> = z
	.uuid({ pattern: UUID_REGEX } as z.core.$ZodUUIDParams)
	.toLowerCase() as z.ZodUUID & z.ZodType<Branded<string, 'Uuid'>, string>;
export type ZodUuid = z.infer<typeof ZodUuid>;

/** `ZodUuid` that defaults to a fresh `create_uuid()` when the input is `undefined`. */
export const ZodUuidWithDefault = ZodUuid.default(create_uuid);
export type ZodUuidWithDefault = z.infer<typeof ZodUuidWithDefault>;

/**
 * Branded datetime schema, zod's default `z.iso.datetime()`: an RFC 3339 date
 * and time in UTC with a real calendar date, `Z` and no offset, and a fraction
 * of any length or none. Zod 4.6 requires the seconds; earlier zod 4, which
 * the `zod` peer range admits, also takes `HH:MMZ`. `Timestamp` is this
 * grammar with the seconds required and the fraction capped at 9 digits, and
 * not branded.
 */
export const Datetime = z.iso.datetime().brand('Datetime');
export type Datetime = z.infer<typeof Datetime>;

/** Returns an ISO 8601 datetime string for the current time. */
export const get_datetime_now = (): Datetime => new Date().toISOString() as Datetime;

/** `Datetime` that defaults to `get_datetime_now()` when the input is `undefined`. */
export const DatetimeNow = Datetime.default(get_datetime_now);
export type DatetimeNow = z.infer<typeof DatetimeNow>;

/**
 * The Zod form of `FactHashSchema`: `FACT_HASH_EXACT`, its output fuz_util's
 * `FactHash`, so a parsed value passes straight to `fact_hash_bytes`,
 * `fact_hash_stream`, and `FactStore`. The two agree on every input, and
 * their JSON Schema is the same `pattern`.
 *
 * The output type is a cast over a plain regex check: Zod's
 * `.brand('FactHash')` would output Zod's own brand, which doesn't fit
 * fuz_util's fuz_schema-branded `FactHash`, and a `.transform` or `z.custom`
 * that produced the right type has no JSON Schema form. The cast costs
 * nothing at runtime and keeps the `ZodString` API and the `pattern`, so
 * `.meta()`, `.nullable()`, and `z.array()` compose as before.
 */
export const ZodFactHashSchema: z.ZodString & z.ZodType<FactHash, string> = z
	.string()
	.regex(FACT_HASH_EXACT) as z.ZodString & z.ZodType<FactHash, string>;

/**
 * The Zod form of `ActingActor`, for a Zod input that needs the caller's
 * acting actor: an optional `ZodUuid` carrying `ACTING_ACTOR_DESCRIPTION`.
 * `ActingActor`'s doc has the resolution rules. The dispatcher finds it by
 * reference, as it does `ActingActor`, so an input declares this export, not
 * a copy of it.
 */
export const ZodActingActor = ZodUuid.optional().meta({ description: ACTING_ACTOR_DESCRIPTION });
export type ZodActingActor = z.infer<typeof ZodActingActor>;

register_zod_acting_actor(ZodActingActor);
