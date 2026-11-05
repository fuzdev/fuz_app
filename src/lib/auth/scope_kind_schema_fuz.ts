/**
 * The `@fuzdev/fuz_schema` twin of the Zod `ScopeKindName`
 * (`auth/scope_kind_schema.ts`), under the same name, for schemas written in
 * fuz_schema.
 *
 * Both are built from the constants `scope_kind_schema.ts` exports, so the
 * bound, the grammar and the two messages can't drift apart. They give every
 * input the same verdict and output, and write the same JSON Schema
 * (`maxLength` and `pattern`); a string both too long and outside the grammar
 * gets the one length issue from this twin, as its `pipe` stops at the first
 * failing step, where the Zod one adds the grammar issue after it.
 *
 * The export is `@nodocs` while the Zod `ScopeKindName` stays, as the docs
 * build refuses two exports of one name.
 *
 * @module
 */

import { message, pipe, regex, type Infer } from '@fuzdev/fuz_schema/schema.ts';

import { bounded_string } from '../primitive_schemas_fuz.ts';
import {
	SCOPE_KIND_LENGTH_MAX,
	SCOPE_KIND_NAME_LENGTH_MESSAGE,
	SCOPE_KIND_NAME_PATTERN_MESSAGE,
	SCOPE_KIND_NAME_REGEX
} from './scope_kind_schema.ts';

/**
 * Valid scope-kind name: runs of lowercase letters joined by single
 * underscores, at most `SCOPE_KIND_LENGTH_MAX` UTF-16 code units, the twin of
 * the Zod `ScopeKindName`. A string it refuses gets the Zod one's message; a
 * value that is no string, fuz_schema's.
 *
 * @nodocs
 */
export const ScopeKindName = pipe(
	bounded_string({ max: SCOPE_KIND_LENGTH_MAX, max_message: SCOPE_KIND_NAME_LENGTH_MESSAGE }),
	message(regex(SCOPE_KIND_NAME_REGEX), SCOPE_KIND_NAME_PATTERN_MESSAGE)
);
/** @nodocs */
export type ScopeKindName = Infer<typeof ScopeKindName>;
