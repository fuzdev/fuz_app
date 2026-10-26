/**
 * Shared Zod `.meta()` conventions for fuz_app schemas.
 *
 * Cross-cutting metadata shape used by env schemas, auth input schemas,
 * surface generation, and test helpers.
 *
 * @module
 */

import type { z } from 'zod';

import type { Sensitivity } from './sensitivity.ts';

/** Zod `.meta()` shape for fuz_app schema metadata conventions. */
export interface SchemaFieldMeta {
	description?: string;
	/** Sensitivity level for masking/redaction. `'secret'` masks the value. */
	sensitivity?: Sensitivity;
	/**
	 * Set on an action's **input** schema that accepts `{}` by design while
	 * its handler refuses `{}` with a declared reason — an input taking one of
	 * several optional selectors, where the handler names the missing or
	 * conflicting one (a schema-level refine would answer a reason-less
	 * `invalid_params` first). A call with no input is never valid for such an
	 * action, so the typed surface keeps its input required
	 * (`action_input_is_optional`), and the input-shape invariant ("an input
	 * accepting `{}` accepts `undefined` too") exempts it. Read from the input
	 * schema itself, so a wrapper (`.optional()`, `.extend()`) drops it.
	 */
	empty_input_handler_guarded?: boolean;
}

/**
 * Whether `schema` carries `empty_input_handler_guarded: true` in its `.meta()`.
 *
 * @param schema - an action's input schema
 * @returns whether its handler refuses the `{}` the schema admits
 */
export const is_empty_input_handler_guarded = (schema: z.ZodType): boolean =>
	(schema.meta() as SchemaFieldMeta | undefined)?.empty_input_handler_guarded === true;
