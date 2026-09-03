import '../assert_dev_env.ts';

/**
 * Cross-backend parity suite for **token scoping's non-RPC surface rule** —
 * *a narrowed api token is RPC-only*.
 *
 * ## Why this suite exists
 *
 * Every existing cross-impl token-scope assertion is the `rpc:<method>` arm
 * (the `token_scope_cases` batch in the conformance security slate). The
 * `surface:<name>` arm had **none** — and it is the load-bearing half of the
 * design. Both spines implement it, at the same named surfaces, returning a
 * denial body that is an explicit cross-impl contract
 * (`token_scope_denied_body` ↔ `fuz_auth::token_scope_surface_denied_response`),
 * and nothing compared the two.
 *
 * That gap has the shape this control family keeps finding: the per-method arm
 * was the one everybody looked at, so it was the one that got a gate. The
 * surface arm is where a divergence could sit indefinitely — the schema gate
 * can't see it (no column), the action-manifest gate can't see it (no method),
 * and the spec-derived suites can't see it (these are REST routes, not the
 * declared RPC surface).
 *
 * ## What it pins
 *
 * - **The denial body, byte for byte** — status, `error`, and the exact
 *   `required_scope` capability string, per surface. A spine that renamed a
 *   surface, dropped the `surface:` prefix, or emitted the JSON-RPC envelope
 *   from a REST route fails here.
 * - **Scope outranks role** — a narrowed token whose account *also* lacks the
 *   gating role must hear `token_scope_required`, not
 *   `insufficient_permissions`. This is the observable the TS↔Rust ordering
 *   divergence produced before both spines converged on running the surface
 *   gate ahead of the role gate; it was explicitly *invisible* to the
 *   cross-backend suites, because every scoped-token probe used a token whose
 *   account happened to hold the role.
 *
 * Two non-vacuity controls hold the negatives honest: the narrowed token must
 * still reach the RPC method it *does* name (otherwise a spine that rejected
 * the credential outright would pass every denial), and a **full** bearer must
 * reach the same surface (otherwise a route broken for all bearers would pass
 * too).
 *
 * ## Why the WS upgrade isn't here
 *
 * Rule 3's third probeable surface is the WebSocket upgrade, and it is
 * deliberately omitted: `create_ws_transport` threads cookies, not bearer
 * headers, and a refused upgrade surfaces as a thrown connection error whose
 * body — the thing this suite exists to compare — isn't readable. The two HTTP
 * surfaces are where the denial body is observable, which is what the parity
 * gate needs. The WS gate keeps its per-spine coverage (fuz_app's surface
 * census pins the call site; the Rust census pins its own).
 *
 * `$lib`-free by contract (relative specifiers only), like the sibling
 * cross-backend suites.
 *
 * @module
 */

import { describe, assert } from 'vitest';

import { account_token_create_action_spec } from '../../auth/account_action_specs.ts';
import { ERROR_TOKEN_SCOPE_REQUIRED } from '../../http/error_schemas.ts';
import { test_if } from './capabilities.ts';
import { cross_rpc_call } from './cell_cross_helpers.ts';
import type { RpcPathCapabilityGatedCrossSuiteOptions } from './setup.ts';
import type { FetchTransport } from '../transports/fetch_transport.ts';
import { SPINE_RPC_PATH } from './spine_surface_constants.ts';

/** Default audit-log SSE path — the `audit_stream` surface. */
const DEFAULT_SSE_PATH = '/api/admin/audit/stream';

/**
 * A well-formed hash that no fact has. The scope gate is a pre-authorization
 * guard, so it fires before the handler ever looks the hash up — but *params*
 * validation runs ahead of every auth gate (it is part of addressing the
 * route), so the value still has to parse.
 */
const ABSENT_FACT_HASH = `blake3:${'0'.repeat(64)}`;

/** The single RPC method the narrowed tokens in this suite admit. */
const ADMITTED_METHOD = 'account_verify';

/** Options for the token-scope surface parity suite. */
export interface TokenScopeSurfaceCrossTestOptions extends RpcPathCapabilityGatedCrossSuiteOptions {
	/** Audit-log SSE path. Default `/api/admin/audit/stream`. */
	readonly sse_path?: string;
}

/** The flat denial body both spines must return, for a given surface. */
const surface_denial_body = (surface: string): Record<string, unknown> => ({
	error: ERROR_TOKEN_SCOPE_REQUIRED,
	required_scope: `surface:${surface}`
});

/**
 * Mint a narrowed bearer token over a session, through the production
 * `account_token_create` path.
 *
 * Deliberately not a fixture-level credential: minting it here means the token
 * is produced by the same handler a real minter would use, on whichever
 * account the caller chose — which is what lets the ordering case put a
 * narrowed token on an account that lacks the gating role.
 */
const mint_narrowed_token = async (
	transport: FetchTransport,
	rpc_path: string,
	session_headers: Record<string, string>
): Promise<string> => {
	const res = await cross_rpc_call(
		transport,
		rpc_path,
		account_token_create_action_spec.method,
		{ scope: { kind: 'methods', methods: [ADMITTED_METHOD] }, lifetime: { kind: 'eternal' } },
		session_headers
	);
	assert.ok(res.ok, `minting a narrowed token failed: ${JSON.stringify(res.error)}`);
	const token = (res.result as { token?: unknown } | undefined)?.token;
	assert.ok(typeof token === 'string' && token.length > 0, 'mint returned no token');
	return token;
};

/**
 * Assert a bearer GET is refused with the canonical surface denial.
 *
 * `origin: null` so the bearer credential isn't discarded as browser context,
 * and a fresh jar so no session cookie rides along and answers instead.
 */
const assert_surface_denied = async (
	fresh_transport: (options?: { readonly origin?: string | null }) => FetchTransport,
	path: string,
	token: string,
	surface: string
): Promise<void> => {
	const res = await fresh_transport({ origin: null })(path, {
		headers: { authorization: `Bearer ${token}` }
	});
	assert.strictEqual(res.status, 403, `${path} must refuse a narrowed token with 403`);
	const body: unknown = await res.json();
	assert.deepStrictEqual(
		body,
		surface_denial_body(surface),
		`${path} must return the canonical flat surface denial`
	);
};

export const describe_token_scope_surface_cross_tests = (
	options: TokenScopeSurfaceCrossTestOptions
): void => {
	const { setup_test, capabilities } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;
	const sse_path = options.sse_path ?? DEFAULT_SSE_PATH;

	describe('token scope non-RPC surface parity', () => {
		/**
		 * The non-vacuity control for every denial below: a narrowed token is
		 * still a working credential. Without this, a spine that rejected the
		 * token outright — or never minted it — would pass all four negatives.
		 */
		test_if(true, 'a narrowed token still reaches the method it names', async () => {
			const fixture = await setup_test();
			const token = await mint_narrowed_token(
				fixture.transport,
				rpc_path,
				fixture.create_session_headers()
			);
			const res = await cross_rpc_call(
				fixture.fresh_transport({ origin: null }),
				rpc_path,
				ADMITTED_METHOD,
				undefined,
				{ authorization: `Bearer ${token}` }
			);
			assert.ok(res.ok, `admitted method must succeed: ${JSON.stringify(res.error)}`);
		});

		test_if(
			capabilities.sse,
			'a narrowed token is refused the audit stream (surface:audit_stream)',
			async () => {
				const fixture = await setup_test();
				const token = await mint_narrowed_token(
					fixture.transport,
					rpc_path,
					fixture.create_session_headers()
				);
				await assert_surface_denied(fixture.fresh_transport, sse_path, token, 'audit_stream');
			}
		);

		test_if(
			capabilities.fact_serving,
			'a narrowed token is refused the bare-hash fact read (surface:fact_bare)',
			async () => {
				const fixture = await setup_test();
				const token = await mint_narrowed_token(
					fixture.transport,
					rpc_path,
					fixture.create_session_headers()
				);
				await assert_surface_denied(
					fixture.fresh_transport,
					`/api/facts/${ABSENT_FACT_HASH}`,
					token,
					'fact_bare'
				);
			}
		);

		/**
		 * The surface-level non-vacuity control. A **full** bearer on the same
		 * route must get past the scope gate — proving the denial above is the
		 * scope refusing a narrowed token, not the route refusing every bearer.
		 * A 404 (no such fact) is the expected outcome; anything that isn't the
		 * scope denial satisfies the property, so the assertion is on what the
		 * response must *not* be.
		 */
		test_if(
			capabilities.fact_serving,
			'a full token is not refused by the scope gate on the same route',
			async () => {
				const fixture = await setup_test();
				const res = await fixture.fresh_transport({ origin: null })(
					`/api/facts/${ABSENT_FACT_HASH}`,
					{ headers: fixture.create_bearer_headers() }
				);
				const body = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
				assert.notStrictEqual(
					body?.error,
					ERROR_TOKEN_SCOPE_REQUIRED,
					'a full-authority bearer must not be refused on scope grounds'
				);
			}
		);

		/**
		 * **Scope outranks role**, and this is the case that had no cross-impl
		 * pin while the two spines disagreed about it.
		 *
		 * The surfaces are role-gated, so a narrowed token on an account without
		 * the role could be refused by either gate. The scope gate must answer:
		 * it is the coarser fact about a credential that was never going to be
		 * admitted, and `insufficient_permissions` would instead report on the
		 * deployment's role structure to that credential. Every other
		 * scoped-token probe in the slate uses the keeper's token, whose account
		 * *holds* the role — so both orderings look identical there, which is
		 * exactly why this divergence survived as long as it did.
		 */
		test_if(
			capabilities.fact_serving,
			'scope outranks role — a narrowed token lacking the role hears about its scope',
			async () => {
				const fixture = await setup_test();
				const non_admin = await fixture.create_account({ username: 'scope_before_role' });
				const token = await mint_narrowed_token(
					fixture.fresh_transport(),
					rpc_path,
					non_admin.create_session_headers()
				);
				await assert_surface_denied(
					fixture.fresh_transport,
					`/api/facts/${ABSENT_FACT_HASH}`,
					token,
					'fact_bare'
				);
			}
		);
	});
};
