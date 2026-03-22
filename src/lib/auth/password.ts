/**
 * Password hashing type definitions.
 *
 * Defines the `PasswordHashDeps` injectable interface and `PASSWORD_LENGTH_MIN`.
 * Concrete Argon2id implementation lives in `password_argon2.ts`.
 *
 * @module
 */

import {z} from 'zod';

/** Minimum password length (OWASP recommendation). */
export const PASSWORD_LENGTH_MIN = 12;

/** Maximum password length. Caps hashing cost to prevent DoS via oversized passwords. */
export const PASSWORD_LENGTH_MAX = 300;

/** Password for account creation or password change — enforces current length policy. Also usable for client-side UX validation. */
export const Password = z
	.string()
	.min(PASSWORD_LENGTH_MIN)
	.max(PASSWORD_LENGTH_MAX)
	.meta({sensitivity: 'secret'});
export type Password = z.infer<typeof Password>;

/** Password submitted for login or verification — minimal validation for forward-compatibility if length requirements change. */
export const PasswordProvided = z
	.string()
	.min(1)
	.max(PASSWORD_LENGTH_MAX)
	.meta({sensitivity: 'secret'});
export type PasswordProvided = z.infer<typeof PasswordProvided>;

/**
 * Injectable password hashing dependencies.
 *
 * Groups all three password operations for injection in route factories
 * and other callers. Use `Pick<PasswordHashDeps, ...>` when only a subset is needed:
 *
 * @example
 * ```ts
 * // Login handler only needs verification
 * password: Pick<PasswordHashDeps, 'verify_password' | 'verify_dummy'>;
 * // Bootstrap only needs hashing
 * password: Pick<PasswordHashDeps, 'hash_password'>;
 * ```
 */
export interface PasswordHashDeps {
	hash_password: (password: string) => Promise<string>;
	verify_password: (password: string, password_hash: string) => Promise<boolean>;
	verify_dummy: (password: string) => Promise<boolean>;
}
