/**
 * Account RPC action specs — declarative contract for self-service account
 * operations. Import this module for the specs, Input/Output schemas, and
 * the `all_account_action_specs` registry. Handlers live in
 * `auth/account_actions.ts` so consumers doing typed-client codegen or surface
 * reporting don't transitively drag in server-only query code.
 *
 * @module
 */

import {z} from 'zod';
import {Blake3Hash} from '@fuzdev/fuz_util/hash_blake3.js';

import type {RequestResponseActionSpec} from '../actions/action_spec.js';
import {AuthSessionJson, ClientApiTokenJson, SessionAccountJson} from './account_schema.js';
import {ApiTokenId} from './api_token.js';

// -- Input/output schemas ---------------------------------------------------

/** Input for `account_verify`. No parameters — the caller is the subject. */
export const VerifyInput = z.void();
export type VerifyInput = z.infer<typeof VerifyInput>;

/** Input for `account_session_list`. No parameters. */
export const SessionListInput = z.void();
export type SessionListInput = z.infer<typeof SessionListInput>;

/** Output for `account_session_list`. */
export const SessionListOutput = z.strictObject({
	sessions: z.array(AuthSessionJson),
});
export type SessionListOutput = z.infer<typeof SessionListOutput>;

/** Input for `account_session_revoke`. `session_id` is the blake3 hash. */
export const SessionRevokeInput = z.strictObject({
	session_id: Blake3Hash.meta({description: 'Session id (blake3 hash) to revoke.'}),
});
export type SessionRevokeInput = z.infer<typeof SessionRevokeInput>;

/** Output for `account_session_revoke`. `revoked` is `false` for IDOR misses. */
export const SessionRevokeOutput = z.strictObject({
	ok: z.literal(true),
	revoked: z.boolean(),
});
export type SessionRevokeOutput = z.infer<typeof SessionRevokeOutput>;

/** Input for `account_session_revoke_all`. No parameters. */
export const SessionRevokeAllInput = z.void();
export type SessionRevokeAllInput = z.infer<typeof SessionRevokeAllInput>;

/** Output for `account_session_revoke_all`. */
export const SessionRevokeAllOutput = z.strictObject({
	ok: z.literal(true),
	count: z.number(),
});
export type SessionRevokeAllOutput = z.infer<typeof SessionRevokeAllOutput>;

/** Input for `account_token_create`. */
export const TokenCreateInput = z.strictObject({
	name: z
		.string()
		.default('CLI token')
		.meta({description: 'Human-friendly label; shown in the token list.'}),
});
export type TokenCreateInput = z.infer<typeof TokenCreateInput>;

/** Output for `account_token_create`. `token` is returned exactly once. */
export const TokenCreateOutput = z.strictObject({
	ok: z.literal(true),
	token: z.string().meta({description: 'Raw token — shown once, store securely.'}),
	id: ApiTokenId,
	name: z.string(),
});
export type TokenCreateOutput = z.infer<typeof TokenCreateOutput>;

/** Input for `account_token_list`. No parameters. */
export const TokenListInput = z.void();
export type TokenListInput = z.infer<typeof TokenListInput>;

/** Output for `account_token_list`. Hashes are excluded. */
export const TokenListOutput = z.strictObject({
	tokens: z.array(ClientApiTokenJson),
});
export type TokenListOutput = z.infer<typeof TokenListOutput>;

/** Input for `account_token_revoke`. */
export const TokenRevokeInput = z.strictObject({
	token_id: ApiTokenId.meta({description: 'Public API token id (e.g. `tok_<12 chars>`).'}),
});
export type TokenRevokeInput = z.infer<typeof TokenRevokeInput>;

/** Output for `account_token_revoke`. `revoked` is `false` for IDOR misses. */
export const TokenRevokeOutput = z.strictObject({
	ok: z.literal(true),
	revoked: z.boolean(),
});
export type TokenRevokeOutput = z.infer<typeof TokenRevokeOutput>;

// -- Action specs -----------------------------------------------------------

export const account_verify_action_spec = {
	method: 'account_verify',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: false,
	input: VerifyInput,
	output: SessionAccountJson,
	async: true,
	description: 'Verify the current session and echo the caller account.',
} satisfies RequestResponseActionSpec;

export const account_session_list_action_spec = {
	method: 'account_session_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: false,
	input: SessionListInput,
	output: SessionListOutput,
	async: true,
	description: 'List auth sessions for the current account.',
} satisfies RequestResponseActionSpec;

export const account_session_revoke_action_spec = {
	method: 'account_session_revoke',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: SessionRevokeInput,
	output: SessionRevokeOutput,
	async: true,
	description: 'Revoke a single auth session for the current account (IDOR-guarded).',
} satisfies RequestResponseActionSpec;

export const account_session_revoke_all_action_spec = {
	method: 'account_session_revoke_all',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: SessionRevokeAllInput,
	output: SessionRevokeAllOutput,
	async: true,
	description: 'Revoke every auth session for the current account.',
} satisfies RequestResponseActionSpec;

export const account_token_create_action_spec = {
	method: 'account_token_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: TokenCreateInput,
	output: TokenCreateOutput,
	async: true,
	description: 'Create an API token for the current account. Raw token is returned once.',
} satisfies RequestResponseActionSpec;

export const account_token_list_action_spec = {
	method: 'account_token_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: false,
	input: TokenListInput,
	output: TokenListOutput,
	async: true,
	description: 'List API tokens for the current account. Hashes are never returned.',
} satisfies RequestResponseActionSpec;

export const account_token_revoke_action_spec = {
	method: 'account_token_revoke',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: TokenRevokeInput,
	output: TokenRevokeOutput,
	async: true,
	description: 'Revoke an API token for the current account (IDOR-guarded).',
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
	account_token_revoke_action_spec,
];
