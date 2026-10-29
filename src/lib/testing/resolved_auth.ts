import './assert_dev_env.ts';

/**
 * Test factory for `ResolvedAuth` — the credential the auth middleware chain
 * resolves, built directly for harnesses that preset it on a Hono context
 * (`RESOLVED_AUTH_KEY`) instead of running the middleware.
 *
 * @module
 */

import { create_uuid } from '../primitive_schemas.ts';
import type { BuiltinCredentialType } from '../auth/credential_type_schema.ts';
import type { ResolvedAuth } from '../auth/resolved_auth.ts';
import { hash_session_token } from '../auth/session_queries.ts';
import { token_scope_full, type TokenScope } from '../auth/token_scope.ts';

/** Options for `create_test_resolved_auth`. */
export interface TestResolvedAuthOptions {
	credential_type: BuiltinCredentialType;
	account_id: string;
	/**
	 * The raw session token a `session` credential carries, hashed into its
	 * `session_hash` the way the session leg hashes the cookie's. Default a
	 * fresh uuid. Ignored for other credential types.
	 */
	session_id?: string;
	/** The `api_token` credential's token id. Default a fresh uuid. Ignored for other credential types. */
	api_token_id?: string;
	/** The `api_token` credential's scope. Default `full`. Ignored for other credential types. */
	scope?: TokenScope;
	/** The credential deadline. Default `null`; always `null` for a daemon token. */
	credential_deadline?: number | null;
}

/**
 * Build the `ResolvedAuth` arm for a credential type, as the auth middleware
 * would for that credential.
 *
 * @param options - the credential type, account, and the fields of its arm
 * @returns the resolved credential
 */
export const create_test_resolved_auth = (options: TestResolvedAuthOptions): ResolvedAuth => {
	const { credential_type, account_id } = options;
	const credential_deadline = options.credential_deadline ?? null;
	switch (credential_type) {
		case 'session':
			return {
				credential_type,
				account_id,
				session_hash: hash_session_token(options.session_id ?? create_uuid()),
				credential_deadline
			};
		case 'api_token':
			return {
				credential_type,
				account_id,
				api_token_id: options.api_token_id ?? create_uuid(),
				scope: options.scope ?? token_scope_full(),
				credential_deadline
			};
		case 'daemon_token':
			return { credential_type, account_id, credential_deadline: null };
	}
};
