import '../assert_dev_env.ts';

/**
 * Mint a narrowed (method-scoped) api token through the production
 * `account_token_create` path, for suites that probe what a narrowed token is
 * refused.
 *
 * Minted rather than seeded: the token comes out of the same handler a real
 * minter uses, on whichever account owns the session the caller passes — so a
 * suite can put a narrowed token on an account that lacks a gating role, and
 * the mint itself asserts that a narrowed scope is accepted at the mint
 * boundary, not merely stored.
 *
 * @module
 */

import { account_token_create_action_spec } from '../../auth/account_action_specs.ts';
import { rpc_call_for_spec, type RpcCallApp } from '../rpc_helpers.ts';

/** Options for `mint_narrowed_api_token`. */
export interface MintNarrowedApiTokenOptions {
	/** Transport the mint goes over — it must carry an allowed `Origin` (the default `rpc_call` one does). */
	readonly app: RpcCallApp;
	/** RPC endpoint path `account_token_create` is mounted on. */
	readonly rpc_path: string;
	/** Session credential headers of the account that owns the token — the mint is session-only. */
	readonly session_headers: Record<string, string>;
	/** The RPC methods the token admits; every other method and every non-RPC surface refuses it. */
	readonly methods: ReadonlyArray<string>;
	/** Token label. Default `'narrowed test token'`. */
	readonly name?: string;
}

/**
 * Mint a narrowed api token and return its raw bearer value.
 *
 * @returns the raw token, for an `Authorization: Bearer` header
 * @throws Error when the mint is refused, naming the status and error
 */
export const mint_narrowed_api_token = async (
	options: MintNarrowedApiTokenOptions
): Promise<string> => {
	const { app, rpc_path, session_headers, methods, name = 'narrowed test token' } = options;
	const res = await rpc_call_for_spec({
		app,
		path: rpc_path,
		spec: account_token_create_action_spec,
		params: {
			name,
			scope: { kind: 'methods', methods: [...methods] },
			lifetime: { kind: 'eternal' }
		},
		headers: session_headers
	});
	if (!res.ok) {
		throw new Error(
			`minting a narrowed api token failed with ${res.status}: ${JSON.stringify(res.error)}`
		);
	}
	return res.result.token;
};
