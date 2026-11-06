/**
 * The `@fuzdev/fuz_schema` twins of the Zod `AuditEventTypeName` and
 * `AuditOutcome` (`auth/audit_log_schema.ts`), under the same names, for
 * schemas written in fuz_schema.
 *
 * `AuditEventTypeName` is built from the constants the Zod one is, the
 * grammar and the two messages this module exports and the bound of
 * `auth/name_schema.ts`, so the two can't drift apart. The constants live
 * here, not beside the Zod schema, because `audit_log_schema.ts` builds its
 * wire rows from these twins. They give every input
 * the same verdict and output, and write the same JSON Schema (`maxLength`
 * and `pattern`); a string both too long and off the grammar gets the one
 * length issue from this twin, as its `pipe` stops at the first failing step,
 * where the Zod one adds the grammar issue after it.
 *
 * The twins are `@nodocs` while the Zod schemas of the same names stay, as
 * the docs build refuses two exports of one name.
 *
 * @module
 */

import { message, one_of, pipe, regex, type Infer } from '@fuzdev/fuz_schema/schema.ts';

import { bounded_string } from '../primitive_schemas_fuz.ts';
import { NAME_LENGTH_MAX } from './name_schema.ts';

/**
 * Letter start, then letters, digits, `_`, `.`, `/`, `-`. Accepts snake_case,
 * dotted, and namespaced consumer conventions; rejects empty strings, leading
 * separators, whitespace, and control characters. The audit event type's own
 * grammar, wider than the shared name grammar (`auth/name_schema.ts`), whose
 * length cap `AuditEventTypeName` takes.
 */
export const AUDIT_EVENT_TYPE_NAME_REGEX = /^[A-Za-z][A-Za-z0-9_./-]*$/;

/** The message of an audit event-type name past `NAME_LENGTH_MAX`. */
export const AUDIT_EVENT_TYPE_NAME_LENGTH_MESSAGE = `must be at most ${NAME_LENGTH_MAX} characters`;

/** The message of an audit event-type name off `AUDIT_EVENT_TYPE_NAME_REGEX`. */
export const AUDIT_EVENT_TYPE_NAME_PATTERN_MESSAGE =
	'must start with a letter; only letters, digits, _ . / - allowed';

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
