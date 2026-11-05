/**
 * The `@fuzdev/fuz_schema` twin of the Zod `RoleName` (`auth/role_schema.ts`),
 * under the same name, for schemas written in fuz_schema.
 *
 * Both are built from the constants `role_schema.ts` exports, so the bound,
 * the grammar and the two messages can't drift apart. They give every input
 * the same verdict and output, and write the same JSON Schema
 * (`maxLength` and `pattern`); a string both too long and outside the grammar
 * gets the one length issue from this twin, as its `pipe` stops at the first
 * failing step, where the Zod one adds the grammar issue after it.
 *
 * The export is `@nodocs` while the Zod `RoleName` stays, as the docs build
 * refuses two exports of one name.
 *
 * @module
 */

import { message, pipe, regex, type Infer } from '@fuzdev/fuz_schema/schema.ts';

import { bounded_string } from '../primitive_schemas_fuz.ts';
import {
	ROLE_NAME_LENGTH_MAX,
	ROLE_NAME_LENGTH_MESSAGE,
	ROLE_NAME_PATTERN,
	ROLE_NAME_PATTERN_MESSAGE
} from './role_schema.ts';

/**
 * Valid role name: lowercase letters and underscores, no leading/trailing
 * underscore, at most `ROLE_NAME_LENGTH_MAX` UTF-16 code units, the twin of
 * the Zod `RoleName`. A string it refuses gets the Zod one's message; a
 * value that is no string, fuz_schema's.
 *
 * @nodocs
 */
export const RoleName = pipe(
	bounded_string({ max: ROLE_NAME_LENGTH_MAX, max_message: ROLE_NAME_LENGTH_MESSAGE }),
	message(regex(ROLE_NAME_PATTERN), ROLE_NAME_PATTERN_MESSAGE)
);
/** @nodocs */
export type RoleName = Infer<typeof RoleName>;
