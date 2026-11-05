/**
 * The `@fuzdev/fuz_schema` twins of the Zod `AuditEventTypeName` and
 * `AuditOutcome` (`auth/audit_log_schema.ts`), under the same names, for
 * schemas written in fuz_schema.
 *
 * `AuditEventTypeName` is built from the constants the Zod one is, the
 * grammar and the two messages of `audit_log_schema.ts` and the bound of
 * `auth/name_schema.ts`, so the two can't drift apart. They give every input
 * the same verdict and output, and write the same JSON Schema (`maxLength`
 * and `pattern`); a string both too long and off the grammar gets the one
 * length issue from this twin, as its `pipe` stops at the first failing step,
 * where the Zod one adds the grammar issue after it.
 *
 * The exports are `@nodocs` while the Zod schemas of the same names stay, as
 * the docs build refuses two exports of one name.
 *
 * @module
 */

import { message, one_of, pipe, regex, type Infer } from '@fuzdev/fuz_schema/schema.ts';

import { bounded_string } from '../primitive_schemas_fuz.ts';
import { NAME_LENGTH_MAX } from './name_schema.ts';
import {
	AUDIT_EVENT_TYPE_NAME_LENGTH_MESSAGE,
	AUDIT_EVENT_TYPE_NAME_PATTERN_MESSAGE,
	AUDIT_EVENT_TYPE_NAME_REGEX
} from './audit_log_schema.ts';

/**
 * Valid audit event-type name: `AUDIT_EVENT_TYPE_NAME_REGEX`, at most
 * `NAME_LENGTH_MAX` UTF-16 code units, the twin of the Zod
 * `AuditEventTypeName`. A string it refuses gets the Zod one's message; a
 * value that is no string, fuz_schema's.
 *
 * @nodocs
 */
export const AuditEventTypeName = pipe(
	bounded_string({ max: NAME_LENGTH_MAX, max_message: AUDIT_EVENT_TYPE_NAME_LENGTH_MESSAGE }),
	message(regex(AUDIT_EVENT_TYPE_NAME_REGEX), AUDIT_EVENT_TYPE_NAME_PATTERN_MESSAGE)
);
/** @nodocs */
export type AuditEventTypeName = Infer<typeof AuditEventTypeName>;

/**
 * Audit event outcome, the twin of the Zod `AuditOutcome`.
 *
 * @nodocs
 */
export const AuditOutcome = one_of(['success', 'failure']);
/** @nodocs */
export type AuditOutcome = Infer<typeof AuditOutcome>;
