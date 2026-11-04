/**
 * Sensitivity levels for schema metadata.
 *
 * Used by env schemas and action input schemas to control masking/redaction
 * in startup logs, surface explorers, and test output, and to keep values
 * out of URLs. A Zod schema declares it with `.meta({sensitivity})`
 * (`SchemaFieldMeta`, read by `schema_sensitivity`); a `@fuzdev/fuz_schema`
 * schema with `meta(schema, {sensitivity})`, the key this module adds to
 * fuz_schema's `SchemaMeta` by declaration merging, read by
 * `find_schema_sensitivity`. `server/env.ts` and `env/env_schemas.ts` import
 * this module for the declaration, so a consumer of either has the key; a
 * module that imports neither and marks a fuz_schema field adds
 * `import type {} from '@fuzdev/fuz_app/sensitivity.ts';`, which brings the
 * declaration in without an unused binding.
 *
 * @module
 */

import { find_schema_meta } from '@fuzdev/fuz_schema/introspect.ts';
import type { AnySchema } from '@fuzdev/fuz_schema/schema.ts';

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

declare module '@fuzdev/fuz_schema/meta.ts' {
	interface SchemaMeta {
		/**
		 * Sensitivity level (`Sensitivity`): `'secret'` masks the value,
		 * `'personal'` only keeps it out of URLs. Read fail-safe from every
		 * schema the field reaches (`find_schema_sensitivity`).
		 */
		sensitivity?: Sensitivity;
	}
}

/**
 * The strongest `sensitivity` declared on any schema a `@fuzdev/fuz_schema`
 * field reaches — `'secret'` over `'personal'` — the fuz_schema twin of
 * `schema_sensitivity`. Fail-safe: `find_schema_meta` reads every wrapper,
 * every schema and action of a `pipe` (not only its first), every option of a
 * union, and a `lazy`'s schema, so a secret stays masked however the field is
 * wrapped, `message` included, which carries the metadata of the schema it
 * was given over. It stops at structural schemas — an object's entries and an
 * array's items carry their own.
 *
 * @param schema - a field schema, possibly wrapped
 * @returns the strongest level any reachable schema declares, else `undefined`
 */
export const find_schema_sensitivity = (schema: AnySchema): Sensitivity | undefined => {
	let found: Sensitivity | undefined;
	for (const sensitivity of find_schema_meta(schema, 'sensitivity')) {
		if (sensitivity === 'secret') return 'secret';
		found = sensitivity;
	}
	return found;
};
