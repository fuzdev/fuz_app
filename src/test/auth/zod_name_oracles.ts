/**
 * Zod copies of the auth name schemas, the oracles the differential tests
 * hold the `@fuzdev/fuz_schema` ones to: `ZodRoleName`, `ZodScopeKindName`,
 * `ZodGrantPathName`, `ZodCredentialTypeName`, `ZodAuditEventTypeName` and
 * `ZodAuditOutcome`, each built from the constants the library's schema is,
 * as the library built them in Zod.
 *
 * A Zod name schema reports a string both too long and off the grammar with
 * both issues, the length one first, where the library's `pipe` stops at the
 * length one; a value that is no string gets Zod's message.
 *
 * @module
 */

import { z } from 'zod';

import { zod_bounded_string as bounded_string } from '../zod_copies.ts';
import {
	format_name_length_message,
	format_name_pattern_message,
	NAME_LENGTH_MAX,
	NAME_REGEX
} from '#lib/auth/name_schema.ts';
import {
	AUDIT_EVENT_TYPE_NAME_LENGTH_MESSAGE,
	AUDIT_EVENT_TYPE_NAME_PATTERN_MESSAGE,
	AUDIT_EVENT_TYPE_NAME_REGEX
} from '#lib/auth/audit_log_schema.ts';

/**
 * A Zod name schema of one domain: `bounded_string` at `NAME_LENGTH_MAX`, then
 * `NAME_REGEX`, each with the domain's message.
 *
 * @param label - the domain's label, capitalized, e.g. `'Role'`
 * @returns the Zod name schema
 */
export const create_zod_name_schema = (label: string): z.ZodString =>
	bounded_string({
		max: NAME_LENGTH_MAX,
		max_message: format_name_length_message(label)
	}).regex(NAME_REGEX, format_name_pattern_message(label));

export const ZodRoleName = create_zod_name_schema('Role');
export const ZodScopeKindName = create_zod_name_schema('Scope-kind');
export const ZodGrantPathName = create_zod_name_schema('Grant-path');
export const ZodCredentialTypeName = create_zod_name_schema('Credential-type');

export const ZodAuditEventTypeName = bounded_string({
	max: NAME_LENGTH_MAX,
	max_message: AUDIT_EVENT_TYPE_NAME_LENGTH_MESSAGE
}).regex(AUDIT_EVENT_TYPE_NAME_REGEX, { message: AUDIT_EVENT_TYPE_NAME_PATTERN_MESSAGE });

export const ZodAuditOutcome = z.enum(['success', 'failure']);
