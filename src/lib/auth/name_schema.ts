/**
 * The name grammar the auth vocabularies share: runs of lowercase letters
 * joined by single underscores, at most `NAME_LENGTH_MAX` characters.
 *
 * Role names (`RoleName`), scope kinds (`ScopeKindName`), grant paths
 * (`GrantPathName`), credential types (`CredentialTypeName`) and a token's
 * `surface:` name (`is_route_scope_capability`) all hold it, and the audit
 * event type (`AuditEventTypeName`) takes its length cap over a grammar of its
 * own. Each domain keeps its own label in its messages, so the rule is shared
 * and the wording is not: `create_name_schema('Role')` says
 * `Role names must …`. The Rust spine's `is_valid_name` and `NAME_LENGTH_MAX`
 * are its twin.
 *
 * @module
 */

import { message, pipe, regex, type PipeSchema, type string } from '@fuzdev/fuz_schema/schema.ts';

import { bounded_string } from '../primitive_schemas_fuz.ts';

/**
 * The longest name the grammar admits, in UTF-16 code units (what
 * `String.length` measures; for a name on `NAME_REGEX` they are its
 * characters). A name is caller-chosen text until it passes the grammar, and
 * some are copied into a row or an audit row where they enter, so the grammar
 * bounds the length too. Same value as the Rust spine's `NAME_LENGTH_MAX`.
 */
export const NAME_LENGTH_MAX = 64;

/**
 * The grammar of a name: runs of lowercase letters (a-z) joined by single
 * underscores. Rejects empty strings, leading, trailing or consecutive
 * underscores, uppercase, digits, and the partial unique indexes' `'GLOBAL'`
 * token.
 */
export const NAME_REGEX = /^[a-z]+(?:_[a-z]+)*$/;

/**
 * Whether `name` is on the grammar and within `NAME_LENGTH_MAX`.
 *
 * @param name - the name to check
 * @returns `true` when `name` matches `NAME_REGEX` and is at most `NAME_LENGTH_MAX` long
 */
export const is_valid_name = (name: string): boolean =>
	name.length <= NAME_LENGTH_MAX && NAME_REGEX.test(name);

/**
 * The message of a name longer than `NAME_LENGTH_MAX`.
 *
 * @param label - the domain's label, capitalized, e.g. `'Role'` or `'Scope-kind'`
 * @returns `<label> names must be at most 64 characters`
 */
export const format_name_length_message = (label: string): string =>
	`${label} names must be at most ${NAME_LENGTH_MAX} characters`;

/**
 * The message of a name off `NAME_REGEX`.
 *
 * @param label - the domain's label, capitalized, e.g. `'Role'` or `'Scope-kind'`
 * @returns `<label> names must be lowercase letters and underscores (a-z_), no leading, trailing or consecutive underscores`
 */
export const format_name_pattern_message = (label: string): string =>
	`${label} names must be lowercase letters and underscores (a-z_), no leading, trailing or consecutive underscores`;

/**
 * A `@fuzdev/fuz_schema` schema for a name of one domain: `bounded_string`
 * at `NAME_LENGTH_MAX`, then `NAME_REGEX`, each with the domain's message. A
 * string both too long and off the grammar gets the one length issue, as the
 * `pipe` stops at its first failing step; a value that is no string gets
 * fuz_schema's message. Its JSON Schema is `maxLength` and `pattern`.
 *
 * @param label - the domain's label, capitalized, e.g. `'Role'` or `'Scope-kind'`
 * @returns the name schema
 */
export const create_name_schema = (
	label: string
): PipeSchema<string, PipeSchema<string, typeof string>> =>
	pipe(
		bounded_string({ max: NAME_LENGTH_MAX, max_message: format_name_length_message(label) }),
		message(regex(NAME_REGEX), format_name_pattern_message(label))
	);
