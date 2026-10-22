import '../assert_dev_env.ts';

/**
 * Cross-backend fact-serving parity suite — the per-reference (cell-scoped)
 * read model over real HTTP.
 *
 * Re-proves the D1 fact-access cases (`docs/security.md` § Fact Access Control)
 * against each backend's real auth resolution, twinning fuz_app's
 * `server/serve_fact_route.ts` and the Rust `fuz_fact_serving` routers:
 *
 * - **cell-scoped admit** — anon reads a fact through a viewable (public)
 *   referencing cell → 200 + bytes;
 * - **cross-owner dedup does not leak** — A's *private* reference to bytes that
 *   B *also* publishes from a *public* cell stays 404 for everyone but A, even
 *   though the identical bytes are world-readable via B's cell (one deduped
 *   `fact` row; authz lives on the `(cell, hash)` edge, never unioned);
 * - **404-mask** — a missing cell and a viewable cell that doesn't reference
 *   the hash both 404 (never 403, never "exists elsewhere"), and every masked
 *   404 is bodyless, so its shape names no branch;
 * - **hardening headers** — a served fact carries `X-Content-Type-Options:
 *   nosniff`, the `default-src 'none'; sandbox` CSP, and `Cache-Control:
 *   private, max-age=300`, whatever its content type;
 * - **bare-hash admin-only** — `GET /api/facts/:hash` is admin (keeper) only:
 *   non-admin → 403, anonymous → 401;
 * - **multi-actor fallthrough** — a multi-actor caller resolves to a null
 *   (anonymous) context on the (`acting`-less) cell-scoped route, so it can't
 *   read its own *private* fact there (admitted only by public cells). Opt-in
 *   (needs the multi-actor setup); every spine resolves the acting actor at the
 *   dispatcher's authorization phase from account-grain credentials, so the
 *   multi-actor account is drivable on TS and Rust alike;
 * - **narrowed-token downgrade** — a scope-narrowed API token on the
 *   cell-scoped route is anonymous, not refused: its owner's private fact 404s
 *   exactly as for an anonymous caller, while a public cell still serves.
 *
 * Facts are seeded **embedded** via `_testing_put_fact` (the cross-process
 * driver has no DB handle); the referencing cell via the `cell_create` RPC
 * (the hash, a whole string value in `data`, is derived into `cell.refs`). A
 * non-admin owner's cell may reference only a fact it holds, so a fact a
 * non-admin references is put with that owner as its `holder` (the keeper is
 * a global admin, whom ref admission doesn't gate). Gated
 * on `capabilities.fact_serving`; runs under every `cross_backend_*` project —
 * the TS spine binary and the Rust `testing_spine_stub` both mount the serve
 * routes + the seeder.
 *
 * @module
 */

import { describe, assert } from 'vitest';
import { z } from 'zod';
import { FactHashSchema } from '../../primitive_schemas.ts';

import { CellCreateOutput } from '../../auth/cell_action_specs.ts';
import {
	FACT_CONTENT_SECURITY_POLICY,
	FACT_X_CONTENT_TYPE_OPTIONS
} from '../../server/fact_security_headers.ts';
import type { FetchTransport } from '../transports/fetch_transport.ts';
import { test_if } from './capabilities.ts';
import { cross_rpc_call, expect_output } from './cell_cross_helpers.ts';
import { mint_narrowed_api_token } from './narrowed_api_token.ts';
import { SPINE_RPC_PATH } from './spine_surface_constants.ts';
import type { RpcPathCapabilityGatedCrossSuiteOptions, SetupTest, TestFixture } from './setup.ts';

/**
 * The fact suite adds one optional knob to the shared cell options: a setup
 * variant whose keeper carries a **second actor**. Only the multi-actor case
 * needs it; the rest of the suite runs single-actor, so wiring it is opt-in.
 * Omit it and the multi-actor case silently skips.
 */
export interface FactServingCrossTestOptions extends RpcPathCapabilityGatedCrossSuiteOptions {
	readonly setup_test_multi_actor?: SetupTest;
}

/** A blake3 hash that is a valid form but references no seeded fact. */
const UNRELATED_HASH = `blake3:${'0'.repeat(64)}`;
/** Nil UUID — a valid `Uuid` param that resolves to no cell. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * `_testing_put_fact`'s output envelope. Parsing the seeder's `result` against
 * it extends the cell suite's wire-shape parity gate (every RPC `result` is
 * schema-checked) to the one fact-suite RPC that previously cast its output —
 * a TS↔Rust drift in the seeder's envelope (extra field, non-`blake3:` hash)
 * fails here rather than silently downstream.
 */
const TestingPutFactOutput = z.strictObject({ hash: FactHashSchema });

/** Input for `cross_put_fact` — `_testing_put_fact`'s params. */
export interface CrossPutFactInput {
	readonly content: string;
	readonly content_type?: string;
	/** The actor the put is on behalf of — recorded as a holder. Omit for a system put. */
	readonly holder?: string;
}

/**
 * Seed an embedded fact over the daemon channel via `_testing_put_fact`;
 * returns its `blake3:` hash. A `holder` is recorded in `fact_holder` (a
 * deduplicated put included), as a real upload records its uploader.
 *
 * @param fixture - the test fixture (its daemon token drives the backdoor)
 * @param rpc_path - the backend's RPC path
 * @param input - the content, optional content type, and optional holder
 * @returns the fact hash
 */
export const cross_put_fact = async (
	fixture: Pick<TestFixture, 'fresh_transport' | 'create_daemon_token_headers'>,
	rpc_path: string,
	input: CrossPutFactInput
): Promise<string> =>
	expect_output(
		await cross_rpc_call(
			// Origin-free transport — the daemon-token middleware discards the
			// credential when an `Origin` / `Referer` is present (browser
			// context), and cross-process `fixture.transport` auto-adds `Origin`.
			fixture.fresh_transport({ origin: null }),
			rpc_path,
			'_testing_put_fact',
			input,
			fixture.create_daemon_token_headers()
		),
		TestingPutFactOutput
	).hash;

/**
 * `Cache-Control` both spines serve a fact with — private, five minutes (the
 * revocation window a cached read outlives).
 */
const FACT_CACHE_CONTROL = 'private, max-age=300';

/** GET a fact over a cross-process `FetchTransport`; returns `{status, content_type, text, headers}`. */
const fact_get = async (
	transport: FetchTransport,
	path: string,
	headers: Record<string, string>
): Promise<{ status: number; content_type: string | null; text: string; headers: Headers }> => {
	const res = await transport(path, { method: 'GET', headers });
	return {
		status: res.status,
		content_type: res.headers.get('content-type'),
		text: await res.text(),
		headers: res.headers
	};
};

/**
 * Assert a served fact carries the hardening headers — `nosniff`, the
 * sandboxing CSP — and the private cache policy. A spine that dropped either
 * hardening header would serve a user-typed `content_type` (or a sniffable
 * octet-stream) as executable HTML.
 */
const assert_fact_headers = (headers: Headers, label: string): void => {
	assert.strictEqual(
		headers.get('x-content-type-options'),
		FACT_X_CONTENT_TYPE_OPTIONS,
		`${label}: X-Content-Type-Options`
	);
	assert.strictEqual(
		headers.get('content-security-policy'),
		FACT_CONTENT_SECURITY_POLICY,
		`${label}: Content-Security-Policy`
	);
	assert.strictEqual(headers.get('cache-control'), FACT_CACHE_CONTROL, `${label}: Cache-Control`);
};

/**
 * Assert a 404 is the masked one: no body, so the response says nothing about
 * which check refused it.
 */
const assert_masked_404 = (got: { status: number; text: string }, label: string): void => {
	assert.strictEqual(got.status, 404, `${label} did not 404`);
	assert.strictEqual(got.text, '', `${label}: a masked 404 has no body`);
	// TODO: the content type isn't pinned — the Node TS spine answers the
	// bodyless 404 with `text/plain; charset=UTF-8`, Deno, Bun and Rust with none
};

export const describe_fact_serving_cross_tests = (options: FactServingCrossTestOptions): void => {
	const { setup_test, setup_test_multi_actor, capabilities } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	type Fixture = Awaited<ReturnType<typeof setup_test>>;

	/** Seed an embedded system-put fact; returns its `blake3:` hash. */
	const put_fact = (fixture: Fixture, content: string, content_type?: string): Promise<string> =>
		cross_put_fact(
			fixture,
			rpc_path,
			content_type === undefined ? { content } : { content, content_type }
		);

	/**
	 * Create a cell referencing `hash` (`extract_refs` lifts it into `cell.refs`).
	 * Pass `acting` when the caller's account holds more than one actor —
	 * `cell_create` is `actor: 'required'`, so a multi-actor account must
	 * disambiguate or the authorization phase rejects with `actor_required`.
	 */
	const create_cell_with_ref = async (
		transport: FetchTransport,
		headers: Record<string, string>,
		hash: string,
		visibility: 'public' | 'private',
		acting?: string
	): Promise<string> =>
		expect_output(
			await cross_rpc_call(
				transport,
				rpc_path,
				'cell_create',
				acting === undefined
					? { kind: 'doc', data: { cover: hash }, visibility }
					: { kind: 'doc', data: { cover: hash }, visibility, acting },
				headers
			),
			CellCreateOutput
		).cell.id;

	const cell_fact_path = (cell_id: string, hash: string): string =>
		`/api/cells/${cell_id}/facts/${hash}`;

	describe('fact serving parity (cell-scoped per-reference reads)', () => {
		test_if(
			capabilities.fact_serving,
			'cell-scoped admit: anon reads a fact through a public referencing cell',
			async () => {
				const fixture = await setup_test();
				const hash = await put_fact(fixture, 'public-fact-bytes', 'text/plain');
				const cell_id = await create_cell_with_ref(
					fixture.transport,
					fixture.create_session_headers(),
					hash,
					'public'
				);
				const anon = fixture.fresh_transport({ origin: null });
				const got = await fact_get(anon, cell_fact_path(cell_id, hash), {});
				assert.strictEqual(got.status, 200, `expected 200, body: ${got.text}`);
				assert.strictEqual(got.text, 'public-fact-bytes');
				// The served `Content-Type` echoes the seeded value on both backends.
				assert.strictEqual(got.content_type, 'text/plain', 'served content-type drifted');
				assert_fact_headers(got.headers, 'cell-scoped text/plain fact');
			}
		);

		test_if(
			capabilities.fact_serving,
			'cross-owner dedup does not leak: A’s private reference stays 404 while B publishes the same bytes',
			async () => {
				const fixture = await setup_test();
				const a = await fixture.create_account({ username: 'fact_owner_a' });
				const b = await fixture.create_account({ username: 'fact_owner_b' });
				// One fact, identical bytes put by both owners — deduped to a single
				// row, each owner a holder.
				const hash = await cross_put_fact(fixture, rpc_path, {
					content: 'shared-deduped-bytes',
					holder: a.actor.id
				});
				assert.strictEqual(
					await cross_put_fact(fixture, rpc_path, {
						content: 'shared-deduped-bytes',
						holder: b.actor.id
					}),
					hash
				);
				const t = fixture.fresh_transport();
				const a_cell = await create_cell_with_ref(t, a.create_session_headers(), hash, 'private');
				const b_cell = await create_cell_with_ref(t, b.create_session_headers(), hash, 'public');

				// B published it from a public cell → readable via B's cell (anon OK).
				const anon = fixture.fresh_transport({ origin: null });
				const via_b = await fact_get(anon, cell_fact_path(b_cell, hash), {});
				assert.strictEqual(
					via_b.status,
					200,
					`B's public cell should serve the fact: ${via_b.text}`
				);
				// Seeded without a content_type → both backends fall back to octet-stream.
				assert.strictEqual(
					via_b.content_type,
					'application/octet-stream',
					'no-content-type fact should serve as octet-stream'
				);
				assert_fact_headers(via_b.headers, 'octet-stream fact');

				// A's PRIVATE reference must NOT leak — to anon or to B — even though
				// the identical bytes are world-readable via B's public cell.
				const a_via_anon = await fact_get(anon, cell_fact_path(a_cell, hash), {});
				assert_masked_404(a_via_anon, "A's private reference read by anon");
				const a_via_b = await fact_get(t, cell_fact_path(a_cell, hash), b.create_session_headers());
				assert_masked_404(a_via_b, "A's private reference read by B");

				// A can read its own private cell's fact.
				const a_via_a = await fact_get(t, cell_fact_path(a_cell, hash), a.create_session_headers());
				assert.strictEqual(a_via_a.status, 200, 'A could not read its own private fact');
			}
		);

		test_if(
			capabilities.fact_serving,
			'404-mask: missing cell, missing edge, and edge-without-bytes all 404 alike',
			async () => {
				const fixture = await setup_test();
				const hash = await put_fact(fixture, '404-mask-bytes');
				const t = fixture.fresh_transport();
				const admin_headers = fixture.create_session_headers();

				// Missing cell → 404.
				const missing = await fact_get(t, cell_fact_path(NIL_UUID, hash), admin_headers);
				assert_masked_404(missing, 'missing cell');

				// A viewable (keeper-owned, public) cell that references a DIFFERENT
				// hash → 404 (missing cell→fact edge), even though the caller can view
				// the cell. `path` is admin-only and the keeper is admin.
				const unrelated_cell = await create_cell_with_ref(
					t,
					admin_headers,
					UNRELATED_HASH,
					'public'
				);
				const no_edge = await fact_get(t, cell_fact_path(unrelated_cell, hash), admin_headers);
				assert_masked_404(no_edge, 'cell without the edge');

				// Edge present but no `fact` row: the same cell DOES reference
				// `UNRELATED_HASH`, which was never seeded. Cell + edge + view all
				// pass, so this exercises the distinct serve-time "metadata missing"
				// 404 branch — masked identically to the authz 404s above.
				const edge_no_bytes = await fact_get(
					t,
					cell_fact_path(unrelated_cell, UNRELATED_HASH),
					admin_headers
				);
				assert_masked_404(edge_no_bytes, 'edge to an absent fact');
			}
		);

		test_if(capabilities.fact_serving, 'bare-hash route is admin-only', async () => {
			const fixture = await setup_test();
			const non_admin = await fixture.create_account({ username: 'fact_non_admin' });
			const hash = await put_fact(fixture, 'bare-hash-bytes');
			const t = fixture.fresh_transport();

			// keeper holds ROLE_ADMIN → 200 + the actual bytes.
			const as_admin = await fact_get(t, `/api/facts/${hash}`, fixture.create_session_headers());
			assert.strictEqual(as_admin.status, 200, `admin bare-hash read failed: ${as_admin.text}`);
			assert.strictEqual(as_admin.text, 'bare-hash-bytes', 'bare-hash route served wrong bytes');

			// non-admin → 403.
			const as_non_admin = await fact_get(
				t,
				`/api/facts/${hash}`,
				non_admin.create_session_headers()
			);
			assert.strictEqual(as_non_admin.status, 403, 'non-admin reached the bare-hash route');

			// anonymous → 401.
			const anon = fixture.fresh_transport({ origin: null });
			const as_anon = await fact_get(anon, `/api/facts/${hash}`, {});
			assert.strictEqual(as_anon.status, 401, 'anon reached the bare-hash route');
		});

		// A narrowed token reaches no non-RPC surface; on this anonymous-admitting
		// route it is downgraded to anonymous rather than refused (a 403 would
		// enforce nothing — the holder drops the header). So the owner's narrowed
		// token reads exactly what an anonymous caller reads: its private fact
		// 404s, a public cell still serves. The owner's full-scope bearer reading
		// the private fact pins that the 404 is the scope, not the bearer.
		test_if(
			capabilities.fact_serving,
			'narrowed api token is treated as anonymous on the cell-scoped route',
			async () => {
				const fixture = await setup_test();
				const owner = await fixture.create_account({ username: 'fact_narrowed_owner' });
				const hash = await cross_put_fact(fixture, rpc_path, {
					content: 'narrowed-token-bytes',
					holder: owner.actor.id
				});
				const t = fixture.fresh_transport();
				const session = owner.create_session_headers();
				const private_cell = await create_cell_with_ref(t, session, hash, 'private');
				const public_cell = await create_cell_with_ref(t, session, hash, 'public');
				const token = await mint_narrowed_api_token({
					app: fixture.transport,
					rpc_path,
					session_headers: session,
					methods: ['cell_get']
				});
				// no `Origin` — a bearer in a browser context is discarded
				const bare = fixture.fresh_transport({ origin: null });
				const narrowed = { authorization: `Bearer ${token}` };

				const full = await fact_get(
					bare,
					cell_fact_path(private_cell, hash),
					owner.create_bearer_headers()
				);
				assert.strictEqual(full.status, 200, `full-scope bearer read failed: ${full.text}`);

				const anon_private = await fact_get(bare, cell_fact_path(private_cell, hash), {});
				const narrowed_private = await fact_get(bare, cell_fact_path(private_cell, hash), narrowed);
				assert.strictEqual(anon_private.status, 404, 'anon read a private fact');
				assert.strictEqual(narrowed_private.status, 404, 'narrowed token read a private fact');
				assert.strictEqual(
					narrowed_private.text,
					anon_private.text,
					'narrowed 404 differs from anon'
				);

				const narrowed_public = await fact_get(bare, cell_fact_path(public_cell, hash), narrowed);
				assert.strictEqual(narrowed_public.status, 200, 'narrowed token refused a public cell');
				assert.strictEqual(narrowed_public.text, 'narrowed-token-bytes');
			}
		);

		// The cell-scoped route is pure-public — no `acting?` slot — so the handler
		// can't disambiguate a multi-actor account and resolves it to a null
		// (anonymous) context. This pins that fallthrough: a multi-actor caller is
		// admitted ONLY by public cells, never via owner / grant / admin — so it
		// can't read its own PRIVATE fact through this route. (Contrast the
		// single-actor owner in the cross-owner case above, who reads its own
		// private fact → 200.) Gated on the opt-in multi-actor setup.
		test_if(
			capabilities.fact_serving && setup_test_multi_actor !== undefined,
			'multi-actor caller is treated as anonymous (public-only) on the cell-scoped route',
			async () => {
				const fixture = await setup_test_multi_actor!();
				assert.ok(fixture.extra_actors.length >= 1, 'multi-actor setup seeded no second actor');

				const t = fixture.fresh_transport();
				const keeper = fixture.create_session_headers();
				const acting = fixture.actor.id; // the keeper's bootstrap actor

				// Seed a multi-actor account over the wire: the daemon-token put +
				// the actor-required cell creates (disambiguated via `acting`) drive
				// the keeper's two actors. Every spine resolves the acting actor at
				// the dispatcher's authorization phase from account-grain credentials,
				// so this runs on TS and Rust alike.
				const hash = await put_fact(fixture, 'multi-actor-bytes');
				const private_cell = await create_cell_with_ref(t, keeper, hash, 'private', acting);
				const public_cell = await create_cell_with_ref(t, keeper, hash, 'public', acting);

				// Owns a PRIVATE cell, yet reading its own fact back resolves to a null
				// (anonymous) context → 404. The owner path never runs.
				const own_private = await fact_get(t, cell_fact_path(private_cell, hash), keeper);
				assert.strictEqual(
					own_private.status,
					404,
					"multi-actor owner's private read was admitted"
				);

				// A PUBLIC cell still admits the anonymous-treated caller → 200, proving
				// the 404 above is the multi-actor fallthrough, not a blanket block.
				const via_public = await fact_get(t, cell_fact_path(public_cell, hash), keeper);
				assert.strictEqual(via_public.status, 200, 'multi-actor caller blocked from a public cell');
				assert.strictEqual(via_public.text, 'multi-actor-bytes');
			}
		);
	});
};
