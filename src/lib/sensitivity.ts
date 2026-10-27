/**
 * Sensitivity levels for schema metadata.
 *
 * Used by env schemas and action input schemas to control masking/redaction
 * in startup logs, surface explorers, and test output, and to keep values
 * out of URLs.
 *
 * @module
 */

// TODO does this belong in its own module like this? and should it be a schema? what other values?

/**
 * Sensitivity level for a schema field.
 *
 * - `'secret'` — value is masked in logs and UI (e.g. passwords, API keys, signing keys)
 *   and kept out of URLs
 * - `'personal'` — personal data (email fragments, names, search terms about
 *   people): kept out of URLs — a read whose input carries it is sent as a
 *   `POST`, not a `GET` (`schema_has_sensitive_field`) — but not masked in
 *   logs or UI
 */
export type Sensitivity = 'secret' | 'personal';
