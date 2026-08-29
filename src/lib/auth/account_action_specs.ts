/**
 * Account RPC action specs — declarative contract for self-service account
 * operations. Import this module for the specs, Input/Output schemas, and
 * the `all_account_action_specs` registry. Handlers live in
 * `auth/account_actions.ts` so consumers doing typed-client codegen or surface
 * reporting don't transitively drag in server-only query code.
 *
 * @module
 */

import { z } from 'zod';

import { TokenScopeInput } from './token_scope.ts';
import { TokenLifetimeInput } from './token_lifetime.ts';

import type { RequestResponseActionSpec } from '../actions/action_spec.ts';
import {
	AuthSessionJson,
	ClientApiTokenJson,
	SessionAccountJson,
	SessionId
} from './account_schema.ts';
import { ApiTokenId } from './api_token.ts';

// -- Input/output schemas ---------------------------------------------------

/** Input for `account_verify`. No parameters — the caller is the subject. */
export const VerifyInput = z.void();
export type VerifyInput = z.infer<typeof VerifyInput>;

/** Input for `account_session_list`. No parameters. */
export const SessionListInput = z.void();
export type SessionListInput = z.infer<typeof SessionListInput>;

/** Output for `account_session_list`. */
export const SessionListOutput = z.strictObject({
	sessions: z.array(AuthSessionJson)
});
export type SessionListOutput = z.infer<typeof SessionListOutput>;

/** Input for `account_session_revoke`. `session_id` is the blake3 hash. */
export const SessionRevokeInput = z.strictObject({
	session_id: SessionId.meta({ description: 'Session id (blake3 hash) to revoke.' })
});
export type SessionRevokeInput = z.infer<typeof SessionRevokeInput>;

/** Output for `account_session_revoke`. `revoked` is `false` for IDOR misses. */
export const SessionRevokeOutput = z.strictObject({
	ok: z.literal(true),
	revoked: z.boolean()
});
export type SessionRevokeOutput = z.infer<typeof SessionRevokeOutput>;

/** Input for `account_session_revoke_all`. No parameters. */
export const SessionRevokeAllInput = z.void();
export type SessionRevokeAllInput = z.infer<typeof SessionRevokeAllInput>;

/** Output for `account_session_revoke_all`. */
export const SessionRevokeAllOutput = z.strictObject({
	ok: z.literal(true),
	count: z.number()
});
export type SessionRevokeAllOutput = z.infer<typeof SessionRevokeAllOutput>;

/**
 * Input for `account_token_create`.
 *
 * `scope` is **required** — default-deny at mint. There is deliberately no
 * permissive default: a caller who wants full authority spells
 * `{kind: 'full'}`, and the stored document records that they did. That is the
 * reversal of the 2026-02 design, where the field existed but nothing depended
 * on it. Because `scope` has no default, the object as a whole no longer
 * carries `.prefault({})`.
 *
 * `lifetime` follows the same rule — a never-expiring token is
 * `{kind: 'eternal'}`, spelled out, so `expires_at IS NULL` always means
 * "deliberately eternal" (see `auth/token_lifetime.ts`).
 */
export const TokenCreateInput = z.strictObject({
	name: z
		.string()
		.default('CLI token')
		.meta({ description: 'Human-friendly label; shown in the token list.' }),
	scope: TokenScopeInput.meta({
		description:
			"What the token may do. `{kind:'full'}` for full account authority, or " +
			"`{kind:'methods',methods:[…]}` to narrow it to named RPC methods — a " +
			'narrowed token is RPC-only and reaches no non-RPC surface.'
	}),
	lifetime: TokenLifetimeInput.meta({
		description:
			"How long the token lives. `{kind:'eternal'}` never expires; " +
			"`{kind:'ttl',days:N}` expires N days from mint."
	})
});
export type TokenCreateInput = z.infer<typeof TokenCreateInput>;

/** Output for `account_token_create`. `token` is returned exactly once. */
export const TokenCreateOutput = z.strictObject({
	ok: z.literal(true),
	token: z.string().meta({ description: 'Raw token — shown once, store securely.' }),
	id: ApiTokenId,
	name: z.string(),
	expires_at: z
		.string()
		.nullable()
		.meta({ description: 'ISO 8601 expiry, or `null` for an eternal token.' })
});
export type TokenCreateOutput = z.infer<typeof TokenCreateOutput>;

/** Input for `account_token_list`. No parameters. */
export const TokenListInput = z.void();
export type TokenListInput = z.infer<typeof TokenListInput>;

/** Output for `account_token_list`. Hashes are excluded. */
export const TokenListOutput = z.strictObject({
	tokens: z.array(ClientApiTokenJson)
});
export type TokenListOutput = z.infer<typeof TokenListOutput>;

/** Input for `account_token_revoke`. */
export const TokenRevokeInput = z.strictObject({
	token_id: ApiTokenId.meta({ description: 'Public API token id (e.g. `tok_<12 chars>`).' })
});
export type TokenRevokeInput = z.infer<typeof TokenRevokeInput>;

/** Output for `account_token_revoke`. `revoked` is `false` for IDOR misses. */
export const TokenRevokeOutput = z.strictObject({
	ok: z.literal(true),
	revoked: z.boolean()
});
export type TokenRevokeOutput = z.infer<typeof TokenRevokeOutput>;

// -- Action specs -----------------------------------------------------------

export const account_verify_action_spec = {
	method: 'account_verify',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: false,
	input: VerifyInput,
	output: SessionAccountJson,
	async: true,
	description: 'Verify the current session and echo the caller account.'
} satisfies RequestResponseActionSpec;

export const account_session_list_action_spec = {
	method: 'account_session_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: false,
	input: SessionListInput,
	output: SessionListOutput,
	async: true,
	description: 'List auth sessions for the current account.'
} satisfies RequestResponseActionSpec;

// `credential_types: ['session']` — see `docs/security.md` §Credential-channel gating.
// A leaked bearer can otherwise compose `account_session_list` + N×revoke to
// reach the same effect as `account_session_revoke_all`.
export const account_session_revoke_action_spec = {
	method: 'account_session_revoke',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none', credential_types: ['session'] },
	side_effects: true,
	input: SessionRevokeInput,
	output: SessionRevokeOutput,
	async: true,
	description: 'Revoke a single auth session for the current account (IDOR-guarded).'
} satisfies RequestResponseActionSpec;

// `credential_types: ['session']` — see `docs/security.md` §Credential-channel gating.
export const account_session_revoke_all_action_spec = {
	method: 'account_session_revoke_all',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none', credential_types: ['session'] },
	side_effects: true,
	input: SessionRevokeAllInput,
	output: SessionRevokeAllOutput,
	async: true,
	description: 'Revoke every auth session for the current account.'
} satisfies RequestResponseActionSpec;

/**
 * `credential_types: ['session']` — see `docs/security.md` §Credential-channel gating.
 *
 * `rate_limit: 'account'` bounds the burn rate of API-token creates. The
 * outstanding-token count is already capped by `max_tokens` (via
 * `query_api_token_enforce_limit`), but the per-account *rate* of churn
 * is not — without this cap, a caller could rotate tokens in a tight
 * loop to amplify `token_create` audit churn or attempt to provoke
 * downstream rate-limit hot spots.
 */
export const account_token_create_action_spec = {
	method: 'account_token_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none', credential_types: ['session'] },
	side_effects: true,
	input: TokenCreateInput,
	output: TokenCreateOutput,
	async: true,
	description: 'Create an API token for the current account. Raw token is returned once.',
	rate_limit: 'account'
} satisfies RequestResponseActionSpec;

export const account_token_list_action_spec = {
	method: 'account_token_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: false,
	input: TokenListInput,
	output: TokenListOutput,
	async: true,
	description: 'List API tokens for the current account. Hashes are never returned.'
} satisfies RequestResponseActionSpec;

// `credential_types: ['session']` — see `docs/security.md` §Credential-channel gating.
export const account_token_revoke_action_spec = {
	method: 'account_token_revoke',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none', credential_types: ['session'] },
	side_effects: true,
	input: TokenRevokeInput,
	output: TokenRevokeOutput,
	async: true,
	description: 'Revoke an API token for the current account (IDOR-guarded).'
} satisfies RequestResponseActionSpec;

/**
 * All self-service account action specs — a codegen-ready registry.
 * Consumers spread this into their own action-spec array to include
 * account methods in a typed client surface.
 */
export const all_account_action_specs: Array<RequestResponseActionSpec> = [
	account_verify_action_spec,
	account_session_list_action_spec,
	account_session_revoke_action_spec,
	account_session_revoke_all_action_spec,
	account_token_create_action_spec,
	account_token_list_action_spec,
	account_token_revoke_action_spec
];
