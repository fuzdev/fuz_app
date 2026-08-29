/**
 * API token lifetime — the temporal axis of a minted credential.
 *
 * `lifetime` is **required** on `account_token_create`, mirroring `scope`:
 * there is deliberately no default. A caller who wants a never-expiring token
 * spells `{kind: 'eternal'}`, and the request records that they did — an
 * omitted lifetime is a validation error upstream, not an eternal token.
 * `expires_at IS NULL` therefore means "deliberately eternal", never "minted
 * before the policy existed".
 *
 * Lifetime is deliberately **not** part of the scope document — `TokenScope`
 * is strict on both spines and sits on the hot resolve path. The expiry lives
 * in the indexed `api_token.expires_at` column where the SQL validation gate
 * already enforces it (`expires_at IS NULL OR expires_at > NOW()`).
 *
 * A framework-level ceiling (`max_token_ttl_days`) is deferred until `fuzf`
 * has an expiry story (an expiry-aware read + a 401 hint); see
 * `docs/security.md` §API tokens.
 *
 * @module
 */

import { z } from 'zod';

/**
 * Upper bound on `ttl.days` — a sanity cap (100 years), not a policy ceiling.
 * Shared with the Rust twin so out-of-range requests 400 identically on both
 * spines.
 */
export const TOKEN_TTL_DAYS_MAX = 36_500;

/**
 * Caller-provided lifetime for `account_token_create`.
 *
 * `eternal` mints a never-expiring token (`expires_at` NULL); `ttl` bounds it
 * to `days` from mint time. `eternal` is deliberately the first variant so
 * schema-driven test generators produce it by default.
 */
export const TokenLifetimeInput = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('eternal') }),
	z.strictObject({
		kind: z.literal('ttl'),
		days: z.number().int().min(1).max(TOKEN_TTL_DAYS_MAX)
	})
]);
export type TokenLifetimeInput = z.infer<typeof TokenLifetimeInput>;

/**
 * Resolve a lifetime input to the `expires_at` value the mint query stores.
 *
 * @param lifetime - the validated lifetime input
 * @param now - mint time (injectable for tests; defaults to the current time)
 * @returns the expiry `Date`, or `null` for an eternal token
 */
export const token_lifetime_to_expires_at = (
	lifetime: TokenLifetimeInput,
	now: Date = new Date()
): Date | null => {
	if (lifetime.kind === 'eternal') return null;
	return new Date(now.getTime() + lifetime.days * 86_400_000);
};
