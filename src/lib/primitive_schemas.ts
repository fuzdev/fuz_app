/**
 * Reusable validator-schema primitives — `Username`, `UsernameProvided`,
 * `Email`. Lives at the top level (not inside `auth/` or `http/`) because
 * these shapes don't depend on or imply any domain — accounts hold a
 * username and email, but invites, password resets, future cell-sharing,
 * and other surfaces all reach for the same primitives without going
 * through auth.
 *
 * Split out from `auth/account_schema.ts` so the auth module shrinks to
 * entity types + client-safe JSON shapes (its real responsibility) and
 * non-auth consumers can import these primitives without dragging the
 * auth domain along. Future cross-domain primitives (phone, url, slug)
 * land here too.
 *
 * @module
 */

import {z} from 'zod';

// TODO consider `.brand()` on Username and Email for compile-time safety

/** Minimum username length (must have start + middle + end characters). */
export const USERNAME_LENGTH_MIN = 3;

/** Maximum username length (matches GitHub's limit). */
export const USERNAME_LENGTH_MAX = 39;

/** Maximum length for username input on login/lookup — more permissive than `USERNAME_LENGTH_MAX` for forward-compatibility if the creation limit is raised. */
export const USERNAME_PROVIDED_LENGTH_MAX = 255;

/**
 * Username for account creation — starts with letter, alphanumeric/dash/underscore middle, ends with alphanumeric. No @ or . allowed.
 *
 * Canonicalized to lowercase at parse time. The regex rejects whitespace
 * outright, so `.trim()` is unnecessary here. Storage is canonical across
 * every creation site (bootstrap, signup, admin-create, invite acceptance)
 * because the schema is the single source of truth — eliminates the
 * per-caller `trim().toLowerCase()` ritual and keeps the
 * `LOWER(username) = LOWER($1)` lookup contract simple.
 */
export const Username = z
	.string()
	.min(USERNAME_LENGTH_MIN)
	.max(USERNAME_LENGTH_MAX)
	.regex(/^[a-zA-Z][0-9a-zA-Z_-]*[0-9a-zA-Z]$/)
	.transform((s) => s.toLowerCase());
export type Username = z.infer<typeof Username>;

/**
 * Username submitted for login or lookup — minimal validation for forward-compatibility if format rules change.
 *
 * Canonicalized via `.trim().toLowerCase()` at parse time so login's
 * per-account rate-limit key and DB lookup see a uniform value
 * regardless of casing or surrounding whitespace. Mirrors the storage
 * canonicalization on `Username` so submission and storage agree.
 */
export const UsernameProvided = z
	.string()
	.min(1)
	.max(USERNAME_PROVIDED_LENGTH_MAX)
	.transform((s) => s.trim().toLowerCase());
export type UsernameProvided = z.infer<typeof UsernameProvided>;

/**
 * Email validation. Lives here rather than `@fuzdev/fuz_util` because every
 * current consumer pairs it with `Username` (signup, invites, audit log) —
 * keeping the two together avoids a cross-package import for the
 * identity-primitive bundle. Promote to fuz_util if a non-identity consumer
 * surfaces.
 */
export const Email = z.email();
export type Email = z.infer<typeof Email>;
