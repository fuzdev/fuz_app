import './assert_dev_env.ts';

/**
 * Shared test entity factories for `Account`, `Actor`, `RoleGrant`, `AuditLogEvent`,
 * `RequestContext`, and API tokens.
 *
 * Override types widen branded `Uuid` fields to `string` so tests can pass
 * literal ids without per-call-site casts. The factory brands internally.
 *
 * Uses `create_test_*` names to avoid collisions with real
 * `create_account_with_actor` from `auth/account_queries.ts`.
 *
 * @module
 */

import type { Uuid } from '../primitive_schemas.ts';

import type { Account, Actor, RoleGrant } from '../auth/account_schema.ts';
import type { AuditLogEvent } from '../auth/audit_log_schema.ts';
import type { RequestActorContext } from '../auth/request_context.ts';
import { API_TOKEN_BODY_LENGTH, API_TOKEN_PREFIX } from '../auth/api_token.ts';
import type { ValidatedApiToken } from '../auth/api_token_queries.ts';
import { token_scope_full } from '../auth/token_scope.ts';

/** Override type for `create_test_account` — id-like fields accept plain `string`. */
export type TestAccountOverrides = Partial<Omit<Account, 'id' | 'created_by' | 'updated_by'>> & {
	id?: string;
	created_by?: string | null;
	updated_by?: string | null;
};

/** Create a test `Account` with sensible defaults. */
export const create_test_account = (overrides?: TestAccountOverrides): Account => ({
	id: 'acct-test' as Uuid,
	username: 'test_user',
	email: null,
	email_verified: false,
	password_hash: 'hash',
	created_at: '2024-01-01T00:00:00Z',
	created_by: null,
	updated_at: '2024-01-01T00:00:00Z',
	updated_by: null,
	deleted_at: null,
	deleted_by: null,
	...(overrides as Partial<Account>)
});

/** Override type for `create_test_actor` — id-like fields accept plain `string`. */
export type TestActorOverrides = Partial<Omit<Actor, 'id' | 'account_id' | 'updated_by'>> & {
	id?: string;
	account_id?: string;
	updated_by?: string | null;
};

/** Create a test `Actor` with sensible defaults. */
export const create_test_actor = (overrides?: TestActorOverrides): Actor => ({
	id: 'actor-test' as Uuid,
	account_id: 'acct-test' as Uuid,
	name: 'test_user',
	created_at: '2024-01-01T00:00:00Z',
	updated_at: null,
	updated_by: null,
	deleted_at: null,
	deleted_by: null,
	...(overrides as Partial<Actor>)
});

/** Override type for `create_test_role_grant` — id-like fields accept plain `string`. */
export type TestRoleGrantOverrides = Partial<
	Omit<
		RoleGrant,
		'id' | 'actor_id' | 'scope_kind' | 'scope_id' | 'revoked_by' | 'granted_by' | 'source_offer_id'
	>
> & {
	id?: string;
	actor_id?: string;
	scope_kind?: string | null;
	scope_id?: string | null;
	revoked_by?: string | null;
	granted_by?: string | null;
	source_offer_id?: string | null;
};

/** Create a test `RoleGrant` with sensible defaults. */
export const create_test_role_grant = (overrides?: TestRoleGrantOverrides): RoleGrant => {
	const base: RoleGrant = {
		id: 'role-grant-test' as Uuid,
		actor_id: 'actor-test' as Uuid,
		role: 'admin',
		scope_kind: null,
		scope_id: null,
		created_at: '2024-01-01T00:00:00Z',
		expires_at: null,
		revoked_at: null,
		revoked_by: null,
		revoked_reason: null,
		granted_by: null,
		source_offer_id: null
	};
	return overrides ? { ...base, ...(overrides as Partial<RoleGrant>) } : base;
};

/**
 * Create a test `RequestActorContext` (a `RequestContext` with a resolved
 * actor) with role_grants from partial overrides.
 */
export const create_test_context = (
	role_grants: Array<TestRoleGrantOverrides> = [{}]
): RequestActorContext => ({
	account: create_test_account(),
	actor: create_test_actor(),
	role_grants: role_grants.map((p) => create_test_role_grant(p))
});

/** Override type for `create_test_audit_event` — id-like fields accept plain `string`. */
export type TestAuditEventOverrides = Partial<
	Omit<AuditLogEvent, 'id' | 'actor_id' | 'account_id' | 'target_account_id' | 'target_actor_id'>
> & {
	id?: string;
	actor_id?: string | null;
	account_id?: string | null;
	target_account_id?: string | null;
	target_actor_id?: string | null;
};

/** Create a test `AuditLogEvent` with sensible defaults. */
export const create_test_audit_event = (overrides?: TestAuditEventOverrides): AuditLogEvent => ({
	id: 'evt-test' as Uuid,
	seq: 1,
	event_type: 'login',
	outcome: 'success',
	actor_id: 'actor-test' as Uuid,
	account_id: 'acct-test' as Uuid,
	target_account_id: null,
	target_actor_id: null,
	ip: '127.0.0.1',
	created_at: '2024-01-01T00:00:00Z',
	metadata: null,
	...(overrides as Partial<AuditLogEvent>)
});

/**
 * Create a well-formed raw API token for tests that need a bearer value to
 * pass the `is_api_token_shaped` precheck and reach token validation. The
 * body is `label` padded with `A` to the generated length, so distinct labels
 * give distinct tokens and a token in a failure message reads back to its
 * test. Not a real credential — it authenticates only where a test mocks the
 * lookup.
 *
 * @param label - base64url characters (`A-Z a-z 0-9 - _`) that start the token body
 * @returns `API_TOKEN_PREFIX` plus an `API_TOKEN_BODY_LENGTH`-char body
 * @throws Error when `label` is longer than the body or not base64url
 */
export const create_test_raw_api_token = (label = 'test'): string => {
	if (label.length > API_TOKEN_BODY_LENGTH || !/^[A-Za-z0-9_-]*$/.test(label)) {
		throw new Error(
			`create_test_raw_api_token: label must be at most ${API_TOKEN_BODY_LENGTH} base64url chars, got '${label}'`
		);
	}
	return API_TOKEN_PREFIX + label.padEnd(API_TOKEN_BODY_LENGTH, 'A');
};

/** Override type for `create_test_validated_api_token` — `account_id` accepts plain `string`. */
export type TestValidatedApiTokenOverrides = Partial<Omit<ValidatedApiToken, 'account_id'>> & {
	account_id?: string;
};

/**
 * Create a test `ValidatedApiToken` — what `query_validate_api_token` returns
 * for a live token — with a `full` scope by default.
 */
export const create_test_validated_api_token = (
	overrides?: TestValidatedApiTokenOverrides
): ValidatedApiToken => ({
	id: 'tok_test',
	account_id: 'acct-test' as Uuid,
	name: 'test token',
	token_hash: 'hash',
	expires_at: null,
	last_used_at: null,
	last_used_ip: null,
	created_at: '2024-01-01T00:00:00Z',
	scope: token_scope_full(),
	expires_in_ms: null,
	...(overrides as Partial<ValidatedApiToken>)
});
