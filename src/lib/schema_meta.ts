/**
 * Shared Zod `.meta()` conventions for fuz_app schemas.
 *
 * Cross-cutting metadata shape used by env schemas, auth input schemas,
 * surface generation, and test helpers.
 *
 * @module
 */

import type {Sensitivity} from './sensitivity.js';

/** Zod `.meta()` shape for fuz_app schema metadata conventions. */
export interface SchemaFieldMeta {
	description?: string;
	/** Sensitivity level for masking/redaction. `'secret'` masks the value. */
	sensitivity?: Sensitivity;
}
