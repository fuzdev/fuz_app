/**
 * Test helper for building a `ConnectionIdentity` — the record
 * `ConnectionRegistry.register_pending` and `add_connection` take —
 * with the non-session fields defaulted.
 *
 * @module
 */

import type { ConnectionIdentity } from '#lib/actions/connection_registry.ts';

/**
 * A `ConnectionIdentity` for `account_id`, every other field `null` or empty
 * unless given — a daemon-token connection by default, a session one with
 * `session_hash`, a bearer one with `api_token_id`.
 */
export const create_test_identity = (
	identity: Pick<ConnectionIdentity, 'account_id'> & Partial<ConnectionIdentity>
): ConnectionIdentity => ({
	session_hash: identity.session_hash ?? null,
	account_id: identity.account_id,
	api_token_id: identity.api_token_id ?? null,
	required_roles: identity.required_roles ?? []
});
