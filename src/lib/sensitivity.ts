/**
 * Sensitivity levels for schema metadata.
 *
 * Used by env schemas and auth input schemas to control masking/redaction
 * in startup logs, surface explorers, and test output.
 *
 * @module
 */

// TODO does this belong in its own module like this? and should it be a schema? what other values?

/**
 * Sensitivity level for a schema field.
 *
 * - `'secret'` — value is masked in logs and UI (e.g. passwords, API keys, signing keys)
 */
export type Sensitivity = 'secret';
