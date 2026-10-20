import '../assert_dev_env.ts';

/**
 * Cross-backend parity suite for the **parent-aware cell-creation authorizer**
 * (`CellCreateAuthorize`) — the directory model.
 *
 * The authorizer adds no method, column, or wire shape, so the schema-snapshot
 * and action-manifest parity gates are **blind** to a TS↔Rust authorizer
 * divergence (the authorizer in the wrong phase, a different deny shape, the
 * 404/403 split, the moderation outcome). This behavioral cross case is the
 * only gate that catches one — proven *here in fuz_app*, against both reference
 * spines.
 *
 * Both spines mount the same directory-model policy (the TS spine binary via
 * `create_test_cell_gated_create_authorize`, the Rust `testing_spine_stub` via
 * `TestCellGatedCreateAuthorize`): admin bypasses; a non-admin creating a
 * `kind: 'space'` **root** is denied (admin-only); a **contribution** under a
 * space is gated by the space's `data.policy[kind] = {min_role, moderation_required}`,
 * with the moderation outcome folded into the verdict; plain parentless creates
 * stay open. The suite asserts all spines agree on:
 *
 * - **root-create admin-only** — a non-admin `space` root → **403**
 *   `cell_create_forbidden`; admin → succeeds.
 * - **contribution gated by the root's policy** — under a public space, an
 *   unauthorized stranger → **403**; a `participant` → succeeds.
 * - **moderation per `moderation_required`** — a `participant`'s `post`
 *   (`moderation_required: true`) is born `moderation: 'pending'` + private; a
 *   `react` (`moderation_required: false`) is born `moderation: 'approved'` at
 *   the author's visibility.
 * - **404 on a hidden parent vs 403 on a visible one** — a contribution under a
 *   **private** space the caller can't view → **404** `cell_not_found` (the
 *   parent is masked); under a **public** space → **403** (you see it, you
 *   can't contribute).
 * - **a soft-deleted root refuses contributions** — soft delete doesn't
 *   cascade, so a live post can sit under a deleted space; a comment under it
 *   → **404** `cell_not_found`, the same shape as a missing parent (the
 *   authorizer never sees a root id without its data).
 * - **clone is no side door** — `cell_clone` runs the authorizer for every cell
 *   it writes as a parentless create, so a non-admin clone of a viewable
 *   `space` root → **403** `cell_create_forbidden`; admin → succeeds.
 *
 * Gated on `capabilities.cell_gated_create` — `true` only on the reference
 * spine binaries that mount the policy, so it skips for generic consumers and
 * the in-process default app (the authorizer hook's in-process coverage is the
 * standalone `auth/cell_create_authorize.db.test.ts`).
 *
 * @module
 */

import { describe, assert } from 'vitest';
import { fractional_index_between } from '@fuzdev/fuz_util/fractional_index.ts';

import {
	CellCloneOutput,
	CellCreateOutput,
	CellListOutput,
	CellModerateOutput,
	CellUpdateOutput
} from '../../auth/cell_action_specs.ts';
import { CellItemInsertOutput, CellItemListOutput } from '../../auth/cell_item_action_specs.ts';
import { CellGrantCreateOutput } from '../../auth/cell_grant_action_specs.ts';
import { z } from 'zod';
import { FactHashSchema } from '../../primitive_schemas.ts';
import { JSONRPC_ERROR_CODES } from '../../http/jsonrpc_errors.ts';
import { test_if } from './capabilities.ts';
import { cross_rpc_call, error_reason, expect_output } from './cell_cross_helpers.ts';
import type { RpcPathCapabilityGatedCrossSuiteOptions } from './setup.ts';
import { SPINE_RPC_PATH } from './spine_surface_constants.ts';
import { SPACE_CELL_KIND, PARTICIPATION_ROLE } from './test_cell_gated_create_authorize.ts';

/**
 * A space `data.policy` mirroring the test ladder: gated `post` (moderated) +
 * `react` (live) + `comment` (live). `comment` exists so the deep-case test can
 * create a comment under a post (`root_id !== parent_id`) and prove the policy
 * resolves from the governing root (the space), not the immediate parent.
 */
const SPACE_POLICY = {
	policy: {
		post: { min_role: PARTICIPATION_ROLE, moderation_required: true },
		react: { min_role: PARTICIPATION_ROLE, moderation_required: false },
		comment: { min_role: PARTICIPATION_ROLE, moderation_required: false }
	}
};

/** `_testing_put_fact`'s output envelope. */
const TestingPutFactOutput = z.strictObject({ hash: FactHashSchema });

export const describe_cell_gated_create_cross_tests = (
	options: RpcPathCapabilityGatedCrossSuiteOptions
): void => {
	const { setup_test, capabilities } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	describe('cell_gated_create authorizer parity (directory model)', () => {
		test_if(
			capabilities.cell_gated_create,
			'a non-admin is denied a `space` root (admin-only), admin succeeds',
			async () => {
				const fixture = await setup_test();
				const stranger = await fixture.create_account({ username: 'space_stranger' });
				const denied = await cross_rpc_call(
					fixture.transport,
					rpc_path,
					'cell_create',
					{ kind: SPACE_CELL_KIND, data: {} },
					stranger.create_session_headers()
				);
				assert.ok(!denied.ok, 'a non-admin must not create a space root');
				assert.strictEqual(error_reason(denied), 'cell_create_forbidden');

				const space = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: SPACE_CELL_KIND, data: SPACE_POLICY, visibility: 'public' },
						fixture.create_session_headers()
					),
					CellCreateOutput
				);
				assert.strictEqual(space.cell.kind, SPACE_CELL_KIND, 'admin creates the space root');
				assert.strictEqual(space.cell.parent_id, null, 'a root is parentless');
				assert.strictEqual(space.cell.root_id, null, 'a root has no governing root');
				assert.strictEqual(
					space.cell.moderation,
					null,
					'a root carries no moderation marker even under a mounted authorizer (moderation is a contribution concept)'
				);
			}
		);

		test_if(
			capabilities.cell_gated_create,
			'a contribution under a public space: unauthorized → 403, participant → allowed',
			async () => {
				const fixture = await setup_test();
				const space = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: SPACE_CELL_KIND, data: SPACE_POLICY, visibility: 'public' },
						fixture.create_session_headers()
					),
					CellCreateOutput
				);

				// A non-participant sees the public space but can't contribute → 403.
				const stranger = await fixture.create_account({ username: 'post_stranger' });
				const forbidden = await cross_rpc_call(
					fixture.transport,
					rpc_path,
					'cell_create',
					{ kind: 'post', data: {}, parent_id: space.cell.id },
					stranger.create_session_headers()
				);
				assert.ok(!forbidden.ok, 'a non-participant must not post in the space');
				assert.strictEqual(error_reason(forbidden), 'cell_create_forbidden');

				// A participant may post; the contribution carries the directory edges.
				const participant = await fixture.create_account({
					username: 'post_participant',
					roles: [PARTICIPATION_ROLE]
				});
				const post = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: 'post', data: {}, parent_id: space.cell.id },
						participant.create_session_headers()
					),
					CellCreateOutput
				);
				assert.strictEqual(post.cell.parent_id, space.cell.id, 'parent edge set');
				assert.strictEqual(post.cell.root_id, space.cell.id, 'root resolved to the space');
			}
		);

		test_if(
			capabilities.cell_gated_create,
			'moderation is set per `moderation_required` (post → pending+private, react → approved)',
			async () => {
				const fixture = await setup_test();
				const space = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: SPACE_CELL_KIND, data: SPACE_POLICY, visibility: 'public' },
						fixture.create_session_headers()
					),
					CellCreateOutput
				);
				const participant = await fixture.create_account({
					username: 'mod_participant',
					roles: [PARTICIPATION_ROLE]
				});

				// `post` requires moderation → born pending + forced private.
				const post = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: 'post', data: {}, parent_id: space.cell.id, visibility: 'public' },
						participant.create_session_headers()
					),
					CellCreateOutput
				);
				assert.strictEqual(post.cell.moderation, 'pending', 'gated post is born pending');
				assert.strictEqual(
					post.cell.visibility,
					'private',
					'a pending contribution is forced private until approved'
				);

				// `react` does not require moderation → born approved at the author's visibility.
				const react = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: 'react', data: {}, parent_id: space.cell.id, visibility: 'public' },
						participant.create_session_headers()
					),
					CellCreateOutput
				);
				assert.strictEqual(react.cell.moderation, 'approved', 'unmoderated kind is born approved');
				assert.strictEqual(react.cell.visibility, 'public', "the author's visibility is honored");
			}
		);

		test_if(
			capabilities.cell_gated_create,
			'a contribution under a hidden (private) space is 404-masked (not 403)',
			async () => {
				const fixture = await setup_test();
				// A private space — only admin/owner can view it.
				const space = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: SPACE_CELL_KIND, data: SPACE_POLICY, visibility: 'private' },
						fixture.create_session_headers()
					),
					CellCreateOutput
				);
				const stranger = await fixture.create_account({ username: 'hidden_stranger' });
				const masked = await cross_rpc_call(
					fixture.transport,
					rpc_path,
					'cell_create',
					{ kind: 'post', data: {}, parent_id: space.cell.id },
					stranger.create_session_headers()
				);
				assert.ok(!masked.ok, 'a stranger must not contribute under a hidden space');
				assert.strictEqual(
					error_reason(masked),
					'cell_not_found',
					'a hidden parent 404-masks the attempt (never reveals it exists)'
				);
			}
		);

		test_if(
			capabilities.cell_gated_create,
			'a deep contribution (comment under a post) resolves policy from the governing root, not the parent',
			async () => {
				const fixture = await setup_test();
				const space = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: SPACE_CELL_KIND, data: SPACE_POLICY, visibility: 'public' },
						fixture.create_session_headers()
					),
					CellCreateOutput
				);
				const participant = await fixture.create_account({
					username: 'deep_participant',
					roles: [PARTICIPATION_ROLE]
				});

				// A post lives directly under the space — the shallow case
				// (`root_id === parent_id`), so the handler reuses the parent row as
				// `root_data`. The post is gated `moderation_required: true`, so it's
				// born pending + private; the author can still view their own pending
				// cell, so it's a valid parent for the comment below.
				const post = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: 'post', data: {}, parent_id: space.cell.id },
						participant.create_session_headers()
					),
					CellCreateOutput
				);
				assert.strictEqual(post.cell.root_id, space.cell.id, 'a post roots at the space');

				// A comment lives under the post — the DEEP case. Here
				// `root_id !== parent_id`, so the handler must read the governing
				// root (the space) *through* the post (the separate in-tx root read),
				// and the authorizer must resolve `policy.comment` from the SPACE's
				// data, not the post's. This is the only case that exercises the
				// deep-read branch on both spines.
				const comment = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: 'comment', data: {}, parent_id: post.cell.id },
						participant.create_session_headers()
					),
					CellCreateOutput
				);
				assert.strictEqual(
					comment.cell.parent_id,
					post.cell.id,
					'the immediate parent is the post'
				);
				assert.strictEqual(
					comment.cell.root_id,
					space.cell.id,
					'the governing root resolves to the space (deep read through the post), not the post'
				);
				assert.strictEqual(
					comment.cell.moderation,
					'approved',
					'the comment policy (moderation_required: false) resolved from the space, not the post'
				);
			}
		);

		test_if(
			capabilities.cell_gated_create,
			'a contribution under a soft-deleted root is 404 cell_not_found (the missing-parent shape)',
			async () => {
				const fixture = await setup_test();
				const admin_headers = fixture.create_session_headers();
				const space = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: SPACE_CELL_KIND, data: SPACE_POLICY, visibility: 'public' },
						admin_headers
					),
					CellCreateOutput
				);
				const participant = await fixture.create_account({
					username: 'tombstone_participant',
					roles: [PARTICIPATION_ROLE]
				});
				const participant_headers = participant.create_session_headers();
				const post = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: 'post', data: {}, parent_id: space.cell.id },
						participant_headers
					),
					CellCreateOutput
				);
				// Soft delete doesn't cascade: the post stays live (and viewable by
				// its author) under the tombstoned space.
				const deleted = await cross_rpc_call(
					fixture.transport,
					rpc_path,
					'cell_delete',
					{ cell_id: space.cell.id },
					admin_headers
				);
				assert.ok(deleted.ok, `cell_delete failed: ${JSON.stringify(deleted.error)}`);

				const refused = await cross_rpc_call(
					fixture.transport,
					rpc_path,
					'cell_create',
					{ kind: 'comment', data: {}, parent_id: post.cell.id },
					participant_headers
				);
				assert.ok(!refused.ok, 'a contribution under a deleted root must be refused');
				assert.strictEqual(error_reason(refused), 'cell_not_found');
				// Byte-identical to the missing-parent refusal.
				const missing_parent = await cross_rpc_call(
					fixture.transport,
					rpc_path,
					'cell_create',
					{ kind: 'comment', data: {}, parent_id: '00000000-0000-4000-8000-000000000000' },
					participant_headers
				);
				assert.deepStrictEqual(refused.error, missing_parent.error);
			}
		);
	});
};

/**
 * Cross-backend parity for the **`cell_moderate` verb** (the `pending →
 * approved | rejected` transition) — root-authority-gated.
 *
 * Builds a moderated public space (admin) + a `participant`'s `post` (born
 * `pending` + private under the `moderation_required: true` policy), then
 * proves both spines agree:
 *
 * - **a root manager (admin) approves** → `moderation: 'approved'` +
 *   `visibility: 'public'` (the contribution goes live).
 * - **the author cannot self-approve** → `403 cell_moderate_forbidden` (the
 *   author can *view* their own pending cell, so they reach the gate, and are
 *   denied — moderation authority is over the governing root, not the
 *   contribution).
 * - **a non-viewer is 404-masked** → a stranger who can't see the pending
 *   contribution gets `cell_not_found`, never learns it exists.
 * - **reject** → `moderation: 'rejected'`, visibility stays private.
 *
 * And that moderation gates reads — a cell's effective audience is its
 * visibility or grants **and** its moderation admission (unmoderated or
 * `approved`), so a pending or rejected contribution reaches no one past its
 * author and admins:
 *
 * - **an author's self-flip to public admits nobody** — a pending post its
 *   author makes public stays 404 to anon and a fresh non-admin on `cell_get`,
 *   and out of their `cell_list`; the author and admin still read it.
 * - **rejection holds a public post back** — pending → rejected → public, and
 *   approved → rejected (approval made it public, rejection leaves visibility
 *   alone), both 404 past the author; a grant made while the post was approved
 *   stops admitting once it is rejected, on `cell_get` and `shared_with: 'me'`.
 * - **an approved post is live** — the control.
 * - **relation reads follow** — a pending post in a public collection is
 *   omitted from anon `cell_item_list`, beside a live sibling that isn't.
 * - **fact serving follows** — a pending post's fact is 404 to anon, even
 *   with the post flipped public (also gated on `capabilities.fact_serving`).
 *
 * Gated on `capabilities.cell_gated_create` — a `pending` contribution only
 * exists when the directory authorizer is mounted (reference spine binaries).
 */
export const describe_cell_moderate_cross_tests = (
	options: RpcPathCapabilityGatedCrossSuiteOptions
): void => {
	const { setup_test, capabilities } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	type Fixture = Awaited<ReturnType<typeof setup_test>>;

	// Build an admin-owned public space (moderated `post` policy) + a
	// participant's pending post under it.
	const setup_pending_post_on = async (
		fixture: Fixture,
		post_data: Record<string, unknown> = {}
	) => {
		const space = expect_output(
			await cross_rpc_call(
				fixture.transport,
				rpc_path,
				'cell_create',
				{ kind: SPACE_CELL_KIND, data: SPACE_POLICY, visibility: 'public' },
				fixture.create_session_headers()
			),
			CellCreateOutput
		);
		const author = await fixture.create_account({
			username: 'moderate_author',
			roles: [PARTICIPATION_ROLE]
		});
		const post = expect_output(
			await cross_rpc_call(
				fixture.transport,
				rpc_path,
				'cell_create',
				{ kind: 'post', data: post_data, parent_id: space.cell.id },
				author.create_session_headers()
			),
			CellCreateOutput
		);
		return { fixture, space, author, post };
	};
	const setup_pending_post = async () => setup_pending_post_on(await setup_test());

	/** Seed an embedded fact over the daemon channel; returns its `blake3:` hash. */
	const put_fact = async (fixture: Fixture, content: string): Promise<string> =>
		expect_output(
			await cross_rpc_call(
				// origin-free — the daemon-token middleware discards the credential beside an `Origin`
				fixture.fresh_transport({ origin: null }),
				rpc_path,
				'_testing_put_fact',
				{ content },
				fixture.create_daemon_token_headers()
			),
			TestingPutFactOutput
		).hash;

	/** The status of a fact GET — `null` headers = anon. */
	const fact_status = async (
		fixture: Fixture,
		path: string,
		headers: Record<string, string> | null
	): Promise<number> => {
		const transport =
			headers === null ? fixture.fresh_transport({ origin: null }) : fixture.transport;
		const res = await transport(path, { method: 'GET', headers: headers ?? {} });
		await res.text();
		return res.status;
	};

	/** `'ok'`, or the refusal reason, for one caller's RPC — `null` headers = anon. */
	const outcome = async (
		fixture: Fixture,
		method: string,
		params: Record<string, unknown>,
		headers: Record<string, string> | null
	): Promise<unknown> => {
		const r =
			headers === null
				? await cross_rpc_call(
						fixture.fresh_transport({ origin: null }),
						rpc_path,
						method,
						params,
						{}
					)
				: await cross_rpc_call(fixture.transport, rpc_path, method, params, headers);
		return r.ok ? 'ok' : error_reason(r);
	};

	/** The ids a caller's `cell_list` returns — `null` headers = anon. */
	const listed_ids = async (
		fixture: Fixture,
		params: Record<string, unknown>,
		headers: Record<string, string> | null
	): Promise<Array<string>> => {
		const r =
			headers === null
				? await cross_rpc_call(
						fixture.fresh_transport({ origin: null }),
						rpc_path,
						'cell_list',
						params,
						{}
					)
				: await cross_rpc_call(fixture.transport, rpc_path, 'cell_list', params, headers);
		return expect_output(r, CellListOutput).cells.map((c) => c.id);
	};

	const moderate = async (
		fixture: Fixture,
		cell_id: string,
		moderation: 'approved' | 'rejected',
		headers: Record<string, string> = fixture.create_session_headers()
	) =>
		expect_output(
			await cross_rpc_call(
				fixture.transport,
				rpc_path,
				'cell_moderate',
				{ cell_id, moderation },
				headers
			),
			CellModerateOutput
		).cell;

	const set_visibility = async (
		fixture: Fixture,
		headers: Record<string, string>,
		cell_id: string,
		visibility: 'public' | 'private'
	) =>
		expect_output(
			await cross_rpc_call(
				fixture.transport,
				rpc_path,
				'cell_update',
				{ cell_id, visibility },
				headers
			),
			CellUpdateOutput
		).cell;

	describe('cell_moderate verb parity (root-authority-gated)', () => {
		test_if(
			capabilities.cell_gated_create,
			'a root manager (admin) approves a pending post → approved + public',
			async () => {
				const { fixture, post } = await setup_pending_post();
				assert.strictEqual(post.cell.moderation, 'pending', 'the post is born pending');
				const moderated = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_moderate',
						{ cell_id: post.cell.id, moderation: 'approved' },
						fixture.create_session_headers() // keeper = admin = root manager
					),
					CellModerateOutput
				);
				assert.strictEqual(moderated.cell.moderation, 'approved', 'approval sets the marker');
				assert.strictEqual(moderated.cell.visibility, 'public', 'approval publishes the post');
			}
		);

		test_if(
			capabilities.cell_gated_create,
			'the author (non-manager) cannot moderate their own pending post → 403',
			async () => {
				const { fixture, author, post } = await setup_pending_post();
				const denied = await cross_rpc_call(
					fixture.transport,
					rpc_path,
					'cell_moderate',
					{ cell_id: post.cell.id, moderation: 'approved' },
					author.create_session_headers()
				);
				assert.ok(!denied.ok, 'the author must not self-approve');
				assert.strictEqual(error_reason(denied), 'cell_moderate_forbidden');
			}
		);

		test_if(
			capabilities.cell_gated_create,
			'a non-viewer is 404-masked from moderating a pending post',
			async () => {
				const { fixture, post } = await setup_pending_post();
				const stranger = await fixture.create_account({ username: 'moderate_stranger' });
				const masked = await cross_rpc_call(
					fixture.transport,
					rpc_path,
					'cell_moderate',
					{ cell_id: post.cell.id, moderation: 'approved' },
					stranger.create_session_headers()
				);
				assert.ok(!masked.ok, 'a non-viewer must not moderate');
				assert.strictEqual(
					error_reason(masked),
					'cell_not_found',
					'a non-viewer never learns the pending post exists'
				);
			}
		);

		test_if(
			capabilities.cell_gated_create,
			'a root manager rejects a pending post → rejected, stays private',
			async () => {
				const { fixture, post } = await setup_pending_post();
				const moderated = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_moderate',
						{ cell_id: post.cell.id, moderation: 'rejected' },
						fixture.create_session_headers()
					),
					CellModerateOutput
				);
				assert.strictEqual(moderated.cell.moderation, 'rejected', 'rejection sets the marker');
				assert.strictEqual(
					moderated.cell.visibility,
					'private',
					'rejection leaves the post private'
				);
			}
		);
	});

	describe('moderation gates reads (parity)', () => {
		test_if(
			capabilities.cell_gated_create,
			'a pending post its author flips public stays hidden past the author and admins',
			async () => {
				const { fixture, space, author, post } = await setup_pending_post();
				const author_h = author.create_session_headers();
				const flipped = await set_visibility(fixture, author_h, post.cell.id, 'public');
				assert.strictEqual(flipped.visibility, 'public', 'the author manages their own post');
				assert.strictEqual(flipped.moderation, 'pending', 'a visibility write leaves moderation');

				const stranger = await fixture.create_account({ username: 'flip_stranger' });
				const stranger_h = stranger.create_session_headers();
				const get = { id: post.cell.id };
				assert.strictEqual(await outcome(fixture, 'cell_get', get, null), 'cell_not_found');
				assert.strictEqual(await outcome(fixture, 'cell_get', get, stranger_h), 'cell_not_found');
				assert.strictEqual(await outcome(fixture, 'cell_get', get, author_h), 'ok');
				assert.strictEqual(
					await outcome(fixture, 'cell_get', get, fixture.create_session_headers()),
					'ok'
				);

				const feed = { root_id: space.cell.id };
				assert.notInclude(await listed_ids(fixture, feed, null), post.cell.id, 'anon list');
				assert.notInclude(await listed_ids(fixture, feed, stranger_h), post.cell.id, 'stranger');
				assert.include(await listed_ids(fixture, feed, author_h), post.cell.id, 'author list');
				assert.include(
					await listed_ids(fixture, feed, fixture.create_session_headers()),
					post.cell.id,
					'admin list'
				);
			}
		);

		test_if(
			capabilities.cell_gated_create,
			'pending → rejected → public stays hidden past the author',
			async () => {
				const { fixture, author, post } = await setup_pending_post();
				const author_h = author.create_session_headers();
				assert.strictEqual(
					(await moderate(fixture, post.cell.id, 'rejected')).moderation,
					'rejected'
				);
				await set_visibility(fixture, author_h, post.cell.id, 'public');
				const stranger = await fixture.create_account({ username: 'rejected_stranger' });
				const get = { id: post.cell.id };
				assert.strictEqual(await outcome(fixture, 'cell_get', get, null), 'cell_not_found');
				assert.strictEqual(
					await outcome(fixture, 'cell_get', get, stranger.create_session_headers()),
					'cell_not_found'
				);
				assert.strictEqual(await outcome(fixture, 'cell_get', get, author_h), 'ok');
			}
		);

		test_if(
			capabilities.cell_gated_create,
			'approved → rejected stays hidden, and a grant made while approved stops admitting',
			async () => {
				const { fixture, author, post } = await setup_pending_post();
				const author_h = author.create_session_headers();
				const friend = await fixture.create_account({ username: 'approved_friend' });
				const friend_h = friend.create_session_headers();
				const stranger = await fixture.create_account({ username: 'approved_stranger' });
				const get = { id: post.cell.id };
				const shared = { shared_with: 'me' };

				// The control: approval publishes the post to everyone.
				assert.strictEqual(
					(await moderate(fixture, post.cell.id, 'approved')).visibility,
					'public'
				);
				assert.strictEqual(await outcome(fixture, 'cell_get', get, null), 'ok', 'approved is live');
				assert.strictEqual(
					await outcome(fixture, 'cell_get', get, stranger.create_session_headers()),
					'ok'
				);

				// A grant made while approved admits on its own once the post is private.
				expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_grant_create',
						{
							cell_id: post.cell.id,
							level: 'viewer',
							principal: { kind: 'actor', actor_id: friend.actor.id }
						},
						author_h
					),
					CellGrantCreateOutput
				);
				await set_visibility(fixture, author_h, post.cell.id, 'private');
				assert.strictEqual(await outcome(fixture, 'cell_get', get, friend_h), 'ok', 'grant admits');
				assert.include(await listed_ids(fixture, shared, friend_h), post.cell.id);

				// Rejection holds it back from the grant holder ...
				assert.strictEqual(
					(await moderate(fixture, post.cell.id, 'rejected')).moderation,
					'rejected'
				);
				assert.strictEqual(await outcome(fixture, 'cell_get', get, friend_h), 'cell_not_found');
				assert.notInclude(await listed_ids(fixture, shared, friend_h), post.cell.id);

				// ... and from everyone once public again; the author still reads it.
				await set_visibility(fixture, author_h, post.cell.id, 'public');
				assert.strictEqual(await outcome(fixture, 'cell_get', get, null), 'cell_not_found');
				assert.strictEqual(
					await outcome(fixture, 'cell_get', get, stranger.create_session_headers()),
					'cell_not_found'
				);
				assert.strictEqual(await outcome(fixture, 'cell_get', get, friend_h), 'cell_not_found');
				assert.strictEqual(await outcome(fixture, 'cell_get', get, author_h), 'ok');
			}
		);

		test_if(
			capabilities.cell_gated_create,
			'approval leaves visibility to rejection: an approved-then-rejected post is still public, and hidden',
			async () => {
				const { fixture, post } = await setup_pending_post();
				await moderate(fixture, post.cell.id, 'approved');
				const rejected = await moderate(fixture, post.cell.id, 'rejected');
				assert.strictEqual(rejected.visibility, 'public', 'rejection does not reset visibility');
				assert.strictEqual(
					await outcome(fixture, 'cell_get', { id: post.cell.id }, null),
					'cell_not_found'
				);
			}
		);

		test_if(
			capabilities.cell_gated_create,
			'an editor grant made while approved admits no write once rejected; the author keeps the owner arm',
			async () => {
				const { fixture, author, post } = await setup_pending_post();
				const author_h = author.create_session_headers();
				const editor = await fixture.create_account({ username: 'rejected_editor' });
				const editor_h = editor.create_session_headers();
				const other = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: 'note', data: {}, visibility: 'public' },
						editor_h
					),
					CellCreateOutput
				);
				await moderate(fixture, post.cell.id, 'approved');
				expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_grant_create',
						{
							cell_id: post.cell.id,
							level: 'editor',
							principal: { kind: 'actor', actor_id: editor.actor.id }
						},
						author_h
					),
					CellGrantCreateOutput
				);
				const update = { cell_id: post.cell.id };
				assert.strictEqual(
					await outcome(fixture, 'cell_update', update, editor_h),
					'ok',
					'the grant admits a write while approved'
				);

				await moderate(fixture, post.cell.id, 'rejected');
				const writes: Array<[string, Record<string, unknown>]> = [
					['cell_get', { id: post.cell.id }],
					['cell_update', update],
					['cell_field_set', { source_id: post.cell.id, name: 'link', target_id: other.cell.id }],
					[
						'cell_item_insert',
						{ parent_id: post.cell.id, child_id: other.cell.id, position: 'a0' }
					],
					['cell_delete', { cell_id: post.cell.id }]
				];
				for (const [method, params] of writes) {
					assert.strictEqual(
						await outcome(fixture, method, params, editor_h),
						'cell_not_found',
						method
					);
				}
				assert.strictEqual(await outcome(fixture, 'cell_update', update, author_h), 'ok', 'author');
			}
		);

		test_if(
			capabilities.cell_gated_create,
			'a pending post in a public collection is omitted from anon cell_item_list',
			async () => {
				const { fixture, space, author, post } = await setup_pending_post();
				const author_h = author.create_session_headers();
				// A live sibling under the same space: a `react` is born approved + public.
				const react = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: 'react', data: {}, parent_id: space.cell.id, visibility: 'public' },
						author_h
					),
					CellCreateOutput
				);
				await set_visibility(fixture, author_h, post.cell.id, 'public');
				const collection = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: 'collection', data: {}, visibility: 'public' },
						author_h
					),
					CellCreateOutput
				);
				const pos_a = fractional_index_between(null, null);
				const pos_b = fractional_index_between(pos_a, null);
				for (const [child_id, position] of [
					[post.cell.id, pos_a],
					[react.cell.id, pos_b]
				] as const) {
					expect_output(
						await cross_rpc_call(
							fixture.transport,
							rpc_path,
							'cell_item_insert',
							{ parent_id: collection.cell.id, child_id, position },
							author_h
						),
						CellItemInsertOutput
					);
				}
				const items = async (headers: Record<string, string> | null) => {
					const params = { parent_id: collection.cell.id };
					const r =
						headers === null
							? await cross_rpc_call(
									fixture.fresh_transport({ origin: null }),
									rpc_path,
									'cell_item_list',
									params,
									{}
								)
							: await cross_rpc_call(
									fixture.transport,
									rpc_path,
									'cell_item_list',
									params,
									headers
								);
					return expect_output(r, CellItemListOutput).items.map((i) => i.child_id);
				};
				assert.deepStrictEqual(
					await items(null),
					[react.cell.id],
					'anon sees the live sibling only'
				);
				assert.deepStrictEqual(await items(author_h), [post.cell.id, react.cell.id]);
			}
		);

		test_if(
			capabilities.cell_gated_create && capabilities.fact_serving,
			"a pending post's fact is 404 to anon, even flipped public; live once approved",
			async () => {
				const fixture = await setup_test();
				const hash = await put_fact(fixture, 'pending-post-fact');
				const { author, post } = await setup_pending_post_on(fixture, { cover: hash });
				await set_visibility(fixture, author.create_session_headers(), post.cell.id, 'public');
				const path = `/api/cells/${post.cell.id}/facts/${hash}`;
				assert.strictEqual(await fact_status(fixture, path, null), 404, 'anon');
				assert.strictEqual(
					await fact_status(fixture, path, author.create_session_headers()),
					200,
					'author'
				);
				await moderate(fixture, post.cell.id, 'approved');
				assert.strictEqual(await fact_status(fixture, path, null), 200, 'approved is live');
			}
		);
	});

	describe('cell_clone runs the creation authorizer (parity)', () => {
		test_if(
			capabilities.cell_gated_create,
			'a non-admin clone of a viewable `space` root → 403, admin clone succeeds',
			async () => {
				const fixture = await setup_test();
				const space = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{ kind: SPACE_CELL_KIND, data: SPACE_POLICY, visibility: 'public' },
						fixture.create_session_headers()
					),
					CellCreateOutput
				);

				// Every cell a clone writes is a parentless create of the source's
				// kind, gated like `cell_create` — so a caller denied a `space` root
				// can't clone one they can see into one they own.
				const stranger = await fixture.create_account({ username: 'clone_stranger' });
				const denied = await cross_rpc_call(
					fixture.transport,
					rpc_path,
					'cell_clone',
					{ source_id: space.cell.id },
					stranger.create_session_headers()
				);
				assert.ok(!denied.ok, 'a non-admin must not clone a space root');
				assert.strictEqual(denied.error?.code, JSONRPC_ERROR_CODES.forbidden, 'a 403');
				assert.strictEqual(error_reason(denied), 'cell_create_forbidden');

				const cloned = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_clone',
						{ source_id: space.cell.id },
						fixture.create_session_headers()
					),
					CellCloneOutput
				);
				assert.strictEqual(cloned.cell.kind, SPACE_CELL_KIND, 'the admin clones the space');
				assert.notStrictEqual(cloned.cell.id, space.cell.id);
				assert.strictEqual(cloned.cell.moderation, null, 'a clone stamps no moderation');
			}
		);
	});
};
