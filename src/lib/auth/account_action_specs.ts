/**
 * Account RPC action specs — declarative contract for self-service account
 * operations. Import this module for the specs, Input/Output schemas, and
 * the `all_account_action_specs` registry. Handlers live in
 * `auth/account_actions.ts` so consumers doing typed-client codegen or surface
 * reporting don't transitively drag in server-only query code.
 *
 * @module
 */

import { meta } from '@fuzdev/fuz_schema/meta.ts';
import {
	array,
	boolean,
	integer,
	literal,
	min_value,
	nullable,
	number,
	object,
	pipe,
	string,
	void as fuz_void,
	with_default,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

import { bounded_string, Timestamp } from '../primitive_schemas_fuz.ts';
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

/** Input for `account_verify`, fuz_schema's `void`. No parameters — the caller is the subject. */
export const VerifyInput = fuz_void;
export type VerifyInput = Infer<typeof VerifyInput>;

/** Input for `account_session_list`, fuz_schema's `void`. No parameters. */
export const SessionListInput = fuz_void;
export type SessionListInput = Infer<typeof SessionListInput>;

/** Output for `account_session_list`, a `@fuzdev/fuz_schema` schema. */
export const SessionListOutput = object({
	sessions: array(AuthSessionJson)
});
export type SessionListOutput = Infer<typeof SessionListOutput>;

/**
 * Input for `account_session_revoke`, a `@fuzdev/fuz_schema` schema.
 * `session_id` is the blake3 hash.
 */
export const SessionRevokeInput = object({
	session_id: meta(SessionId, { description: 'Session id (blake3 hash) to revoke.' })
});
export type SessionRevokeInput = Infer<typeof SessionRevokeInput>;

/**
 * Output for `account_session_revoke`, a `@fuzdev/fuz_schema` schema.
 * `revoked` is `false` for IDOR misses.
 */
export const SessionRevokeOutput = object({
	ok: literal(true),
	revoked: boolean
});
export type SessionRevokeOutput = Infer<typeof SessionRevokeOutput>;

/** Input for `account_session_revoke_all`, fuz_schema's `void`. No parameters. */
export const SessionRevokeAllInput = fuz_void;
export type SessionRevokeAllInput = Infer<typeof SessionRevokeAllInput>;

/**
 * Output for `account_session_revoke_all`, a `@fuzdev/fuz_schema` schema.
 * `count` is the number of sessions revoked.
 */
export const SessionRevokeAllOutput = object({
	ok: literal(true),
	count: pipe(number, integer, min_value(0))
});
export type SessionRevokeAllOutput = Infer<typeof SessionRevokeAllOutput>;

/**
 * Maximum length of an API token's `name`, in UTF-16 code units (what
 * `String.length` measures; enforced by `bounded_string`). The name is copied into the
 * `token_create` audit row, so it is bounded where it enters. Same value as
 * the Rust spine's `API_TOKEN_NAME_LENGTH_MAX`.
 */
export const API_TOKEN_NAME_LENGTH_MAX = 255;

/**
 * `error.data.reason` on any refusal of `account_token_create`'s `scope` —
 * missing, `null`, an unknown `kind` or key, a malformed `methods`, an
 * over-cap document. The field's declared `invalid_reason`.
 */
export const ERROR_TOKEN_SCOPE_INVALID = 'token_scope_invalid' as const;

/**
 * `error.data.reason` on any refusal of `account_token_create`'s `lifetime` —
 * missing, `null`, an unknown `kind` or key, a `days` out of range. The
 * field's declared `invalid_reason`.
 */
export const ERROR_TOKEN_LIFETIME_INVALID = 'token_lifetime_invalid' as const;

/**
 * Input for `account_token_create`, a `@fuzdev/fuz_schema` schema.
 *
 * `scope` is **required** — default-deny at mint. There is deliberately no
 * permissive default: a caller who wants full authority spells
 * `{kind: 'full'}`, and the stored document records that they did. That is the
 * reversal of the 2026-02 design, where the field existed but nothing depended
 * on it. Because `scope` has no default, the object as a whole has none.
 *
 * `lifetime` follows the same rule — a never-expiring token is
 * `{kind: 'eternal'}`, spelled out, so `expires_at IS NULL` always means
 * "deliberately eternal" (see `auth/token_lifetime.ts`).
 */
export const TokenCreateInput = object({
	name: meta(with_default(bounded_string({ max: API_TOKEN_NAME_LENGTH_MAX }), 'CLI token'), {
		description: `Human-friendly label; shown in the token list. At most ${API_TOKEN_NAME_LENGTH_MAX} characters.`
	}),
	scope: meta(TokenScopeInput, {
		description:
			"What the token may do. `{kind:'full'}` for full account authority, or " +
			"`{kind:'methods',methods:[…]}` to narrow it to named RPC methods — a " +
			'narrowed token is RPC-only and reaches no non-RPC surface that reads ' +
			'account data or carries authority.',
		invalid_reason: ERROR_TOKEN_SCOPE_INVALID
	}),
	lifetime: meta(TokenLifetimeInput, {
		description:
			"How long the token lives. `{kind:'eternal'}` never expires; " +
			"`{kind:'ttl',days:N}` expires N days from mint.",
		invalid_reason: ERROR_TOKEN_LIFETIME_INVALID
	})
});
export type TokenCreateInput = Infer<typeof TokenCreateInput>;

/**
 * Output for `account_token_create`, a `@fuzdev/fuz_schema` schema. `token`
 * is returned exactly once.
 */
export const TokenCreateOutput = object({
	ok: literal(true),
	token: meta(string, { description: 'Raw token — shown once, store securely.' }),
	id: ApiTokenId,
	name: string,
	expires_at: meta(nullable(Timestamp), {
		description: 'ISO 8601 expiry, or `null` for an eternal token.'
	})
});
export type TokenCreateOutput = Infer<typeof TokenCreateOutput>;

/** Input for `account_token_list`, fuz_schema's `void`. No parameters. */
export const TokenListInput = fuz_void;
export type TokenListInput = Infer<typeof TokenListInput>;

/** Output for `account_token_list`, a `@fuzdev/fuz_schema` schema. Hashes are excluded. */
export const TokenListOutput = object({
	tokens: array(ClientApiTokenJson)
});
export type TokenListOutput = Infer<typeof TokenListOutput>;

/** Input for `account_token_revoke`, a `@fuzdev/fuz_schema` schema. */
export const TokenRevokeInput = object({
	token_id: meta(ApiTokenId, {
		description: 'Public API token id (e.g. `tok_<12 chars>`).'
	})
});
export type TokenRevokeInput = Infer<typeof TokenRevokeInput>;

/**
 * Output for `account_token_revoke`, a `@fuzdev/fuz_schema` schema.
 * `revoked` is `false` for IDOR misses.
 */
export const TokenRevokeOutput = object({
	ok: literal(true),
	revoked: boolean
});
export type TokenRevokeOutput = Infer<typeof TokenRevokeOutput>;

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
