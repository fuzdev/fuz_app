import '../assert_dev_env.ts';

/**
 * Cross-backend parity suite for **possession-gated cell ref admission** — a
 * non-admin `cell_create` / `cell_update` / `cell_clone` may introduce a fact
 * ref only to a fact its acting actor holds (a `fact_holder` row, recorded on
 * every put that names the actor), else `403` with reason
 * `cell_ref_not_held`. Twins the Rust `fuz_cell_actions` `cell_authz` cases of
 * the same names, over real HTTP:
 *
 * - **create admits a new ref only for a holder** — a stored fact the caller
 *   never put and a hash nothing is stored under are refused with one
 *   identical answer (status + error body — no existence oracle), as is a
 *   system-put fact; the uploader's public cell serves the bytes to anyone; a
 *   second actor putting identical bytes becomes a holder;
 * - **update keeps existing refs** — an editor keeps refs another writer
 *   introduced, and adding an unheld one (or dropping a ref and adding it
 *   back) is refused;
 * - **clone carries source refs per row** — a shallow and a deep clone carry
 *   each row's source refs without holding them; a patch adding an unheld
 *   ref, or carrying a child's ref onto the root, is refused;
 * - **a global admin is not gated**;
 * - **a revoked grantee can't re-reference** — a reader who saw a hash through
 *   a granted cell can't name it in a cell of its own, before or after the
 *   revoke (a known hash is not a read capability);
 * - **extraction parity** — a ref is a whole string value exactly matching
 *   `blake3:` + 64 lowercase hex: a hash in prose or markup, `blake3:zz`, an
 *   uppercase digest, and an object key are not refs on either spine;
 * - **admission answers after the masks** — an update of a hidden cell, a
 *   create under a hidden parent, and a clone of a hidden source answer `404`
 *   whatever their `data` names.
 *
 * Facts are put through `_testing_put_fact`, with `holder` naming the actor a
 * real upload would record. Gated on `capabilities.fact_serving` (the
 * seeder + the serve routes); runs under every `cross_backend_*` project.
 *
 * @module
 */

import { describe, assert } from 'vitest';

import {
	CellCloneOutput,
	CellCreateOutput,
	CellGetOutput,
	CellUpdateOutput
} from '../../auth/cell_action_specs.ts';
import { CellGrantCreateOutput } from '../../auth/cell_grant_action_specs.ts';
import { create_rpc_post_init } from '../rpc_helpers.ts';
import type { FetchTransport } from '../transports/fetch_transport.ts';
import { test_if } from './capabilities.ts';
import { cross_rpc_call, error_reason, expect_output, type RpcResult } from './cross_rpc.ts';
import { cross_put_fact } from './fact_serving.ts';
import { SPINE_RPC_PATH } from './spine_surface_constants.ts';
import type { RpcPathCapabilityGatedCrossSuiteOptions } from './setup.ts';

/** The admission refusal's reason, on both spines. */
const CELL_REF_NOT_HELD = 'cell_ref_not_held';

/** A well-formed hash no fact is stored under. */
const UNSTORED_HASH = `blake3:${'e'.repeat(64)}`;

/** The status + error of a refused RPC call, for comparing two refusals byte for byte. */
const refusal = async (
	transport: FetchTransport,
	rpc_path: string,
	method: string,
	params: unknown,
	headers: Record<string, string>
): Promise<{ status: number; error: unknown }> => {
	const init = create_rpc_post_init(method, params);
	Object.assign(init.headers as Record<string, string>, headers);
	const res = await transport(rpc_path, init);
	const body = (await res.json()) as { error?: unknown };
	assert.ok(body.error !== undefined, `expected a refusal, got ${JSON.stringify(body)}`);
	return { status: res.status, error: body.error };
};

const assert_not_held = (r: RpcResult, label: string): void => {
	assert.ok(!r.ok, `${label}: expected a refusal, got ${JSON.stringify(r.result)}`);
	assert.strictEqual(error_reason(r), CELL_REF_NOT_HELD, `${label}: ${JSON.stringify(r.error)}`);
};

export const describe_cell_ref_admission_cross_tests = (
	options: RpcPathCapabilityGatedCrossSuiteOptions
): void => {
	const { setup_test, capabilities } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	describe('cell ref admission parity (possession-gated refs)', () => {
		test_if(
			capabilities.fact_serving,
			'create admits a new ref only for a holder; refusals are identical for stored and unstored hashes',
			async () => {
				const fixture = await setup_test();
				const alice = await fixture.create_account({ username: 'ref_alice' });
				const bob = await fixture.create_account({ username: 'ref_bob' });
				const t = fixture.fresh_transport();
				const bob_headers = bob.create_session_headers();
				const uploaded = await cross_put_fact(fixture, rpc_path, {
					content: 'alice photo bytes',
					holder: alice.actor.id
				});
				const seeded = await cross_put_fact(fixture, rpc_path, { content: 'seeded bytes' });

				// Bob names a stored fact he never put, and a hash nothing is stored
				// under: both refused, with one identical answer.
				const stored = await refusal(
					t,
					rpc_path,
					'cell_create',
					{ kind: 'doc', data: { cover: uploaded }, visibility: 'public' },
					bob_headers
				);
				const unstored = await refusal(
					t,
					rpc_path,
					'cell_create',
					{ kind: 'doc', data: { cover: UNSTORED_HASH }, visibility: 'public' },
					bob_headers
				);
				assert.strictEqual(stored.status, 403);
				assert.deepStrictEqual(stored, unstored, 'stored vs unstored refusal differs');
				assert.strictEqual(
					(stored.error as { data?: { reason?: unknown } }).data?.reason,
					CELL_REF_NOT_HELD
				);
				assert.strictEqual(
					(stored.error as { message?: unknown }).message,
					'cell data references a fact the caller does not hold'
				);
				// A system-put fact has no holder at all.
				assert_not_held(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_create',
						{ data: { files: [seeded] } },
						bob_headers
					),
					'system-put ref'
				);

				// The uploader holds it — her public cell serves the bytes to anyone.
				const created = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_create',
						{ kind: 'doc', data: { cover: uploaded }, visibility: 'public' },
						alice.create_session_headers()
					),
					CellCreateOutput
				);
				assert.deepStrictEqual(created.cell.refs, [uploaded]);
				const anon = fixture.fresh_transport({ origin: null });
				const served = await anon(`/api/cells/${created.cell.id}/facts/${uploaded}`, {
					method: 'GET'
				});
				assert.strictEqual(served.status, 200, 'the uploader’s public cell did not serve');
				assert.strictEqual(await served.text(), 'alice photo bytes');

				// Bob puts identical bytes himself: possession, so he holds it too.
				assert.strictEqual(
					await cross_put_fact(fixture, rpc_path, {
						content: 'alice photo bytes',
						holder: bob.actor.id
					}),
					uploaded
				);
				expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_create',
						{ data: { cover: uploaded } },
						bob_headers
					),
					CellCreateOutput
				);
			}
		);

		test_if(
			capabilities.fact_serving,
			'update keeps existing refs and refuses new unheld ones',
			async () => {
				const fixture = await setup_test();
				const alice = await fixture.create_account({ username: 'ref_upd_alice' });
				const bob = await fixture.create_account({ username: 'ref_upd_bob' });
				const t = fixture.fresh_transport();
				const alice_headers = alice.create_session_headers();
				const bob_headers = bob.create_session_headers();
				const alices = await cross_put_fact(fixture, rpc_path, {
					content: 'alice cover bytes',
					holder: alice.actor.id
				});
				const alices_other = await cross_put_fact(fixture, rpc_path, {
					content: 'alice other bytes',
					holder: alice.actor.id
				});
				const bobs = await cross_put_fact(fixture, rpc_path, {
					content: 'bob file bytes',
					holder: bob.actor.id
				});
				// Alice's cell carries her ref; Bob edits it through an editor grant.
				const cell_id = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_create',
						{ data: { cover: alices } },
						alice_headers
					),
					CellCreateOutput
				).cell.id;
				expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_grant_create',
						{ cell_id, level: 'editor', principal: { kind: 'actor', actor_id: bob.actor.id } },
						alice_headers
					),
					CellGrantCreateOutput
				);

				// Keeping Alice's ref — beside an edit and a ref Bob holds — is admitted.
				const kept = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_update',
						{ cell_id, data: { cover: alices, label: 'edited', file: bobs } },
						bob_headers
					),
					CellUpdateOutput
				);
				assert.deepStrictEqual(kept.cell.refs, [alices, bobs].sort());

				// Adding one he doesn't hold is refused.
				for (const added of [alices_other, UNSTORED_HASH]) {
					assert_not_held(
						await cross_rpc_call(
							t,
							rpc_path,
							'cell_update',
							{ cell_id, data: { cover: alices, file: added } },
							bob_headers
						),
						`update adding ${added}`
					);
				}
				// Dropping a ref and adding it back is a new ref — the base is what
				// the cell carries now.
				expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_update',
						{ cell_id, data: { label: 'dropped' } },
						bob_headers
					),
					CellUpdateOutput
				);
				assert_not_held(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_update',
						{ cell_id, data: { cover: alices } },
						bob_headers
					),
					'update restoring a dropped ref'
				);
			}
		);

		test_if(
			capabilities.fact_serving,
			'clone carries source refs per row without holding them',
			async () => {
				const fixture = await setup_test();
				const alice = await fixture.create_account({ username: 'ref_clone_alice' });
				const bob = await fixture.create_account({ username: 'ref_clone_bob' });
				const t = fixture.fresh_transport();
				const alice_headers = alice.create_session_headers();
				const bob_headers = bob.create_session_headers();
				const cover = await cross_put_fact(fixture, rpc_path, {
					content: 'cover bytes',
					holder: alice.actor.id
				});
				const attachment = await cross_put_fact(fixture, rpc_path, {
					content: 'attachment bytes',
					holder: alice.actor.id
				});
				const create = async (data: Record<string, unknown>): Promise<string> =>
					expect_output(
						await cross_rpc_call(
							t,
							rpc_path,
							'cell_create',
							{ data, visibility: 'public' },
							alice_headers
						),
						CellCreateOutput
					).cell.id;
				const source = await create({ cover });
				const child = await create({ file: attachment });
				const inserted = await cross_rpc_call(
					t,
					rpc_path,
					'cell_item_insert',
					{ parent_id: source, child_id: child, position: 'a0' },
					alice_headers
				);
				assert.ok(inserted.ok, JSON.stringify(inserted.error));

				// Shallow: the root row carries the source's ref.
				const shallow = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_clone', { source_id: source }, bob_headers),
					CellCloneOutput
				);
				assert.deepStrictEqual(shallow.cell.refs, [cover]);
				assert.strictEqual(shallow.cell.created_by, bob.actor.id);

				// Deep: each child row is checked against its own source row, so the
				// child's ref — not on the root — is carried too.
				const deep = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_clone',
						{ source_id: source, deep: true },
						bob_headers
					),
					CellCloneOutput
				);
				assert.deepStrictEqual(deep.cell.refs, [cover]);
				const bundle = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_get', { id: deep.cell.id }, bob_headers),
					CellGetOutput
				);
				assert.strictEqual(bundle.items.length, 1, 'the deep clone dropped its child');
				const cloned_child = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_get',
						{ id: bundle.items[0]!.child_id },
						bob_headers
					),
					CellGetOutput
				);
				assert.notStrictEqual(cloned_child.cell.id, child);
				assert.deepStrictEqual(cloned_child.cell.refs, [attachment]);

				// A patch introducing an unheld ref is refused, deep or shallow.
				assert_not_held(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_clone',
						{ source_id: source, deep: true, with_data_patch: { extra: UNSTORED_HASH } },
						bob_headers
					),
					'deep clone with an unheld patch ref'
				);
				// The child's ref is not on the root: carrying it onto the root through
				// a patch is a new ref there.
				assert_not_held(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_clone',
						{ source_id: source, with_data_patch: { extra: attachment } },
						bob_headers
					),
					'clone moving a child ref onto the root'
				);
			}
		);

		test_if(capabilities.fact_serving, 'a global admin is not gated on refs', async () => {
			const fixture = await setup_test();
			const t = fixture.fresh_transport();
			const seeded = await cross_put_fact(fixture, rpc_path, { content: 'admin seeded bytes' });
			// The keeper holds the global admin grant.
			for (const named of [seeded, UNSTORED_HASH]) {
				const created = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_create',
						{ data: { cover: named } },
						fixture.create_session_headers()
					),
					CellCreateOutput
				);
				assert.deepStrictEqual(created.cell.refs, [named]);
			}
		});

		test_if(
			capabilities.fact_serving,
			'a revoked grantee cannot re-reference a fact it read',
			async () => {
				const fixture = await setup_test();
				const alice = await fixture.create_account({ username: 'ref_rev_alice' });
				const bob = await fixture.create_account({ username: 'ref_rev_bob' });
				const t = fixture.fresh_transport();
				const alice_headers = alice.create_session_headers();
				const bob_headers = bob.create_session_headers();
				const hash = await cross_put_fact(fixture, rpc_path, {
					content: 'alice private bytes',
					holder: alice.actor.id
				});
				const cell_id = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_create',
						{ data: { file: hash }, visibility: 'private' },
						alice_headers
					),
					CellCreateOutput
				).cell.id;
				const grant = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_grant_create',
						{ cell_id, level: 'viewer', principal: { kind: 'actor', actor_id: bob.actor.id } },
						alice_headers
					),
					CellGrantCreateOutput
				).grant;
				// Bob reads the bytes through the granted cell, so he has seen the hash…
				const read = await t(`/api/cells/${cell_id}/facts/${hash}`, {
					method: 'GET',
					headers: bob_headers
				});
				assert.strictEqual(read.status, 200, 'the grantee could not read the fact');
				// …but naming it in a public cell of his own is refused, now and after
				// the revoke: seeing a hash is not holding the bytes.
				const republish = { data: { file: hash }, visibility: 'public' };
				assert_not_held(
					await cross_rpc_call(t, rpc_path, 'cell_create', republish, bob_headers),
					'grantee republish'
				);
				const revoked = await cross_rpc_call(
					t,
					rpc_path,
					'cell_grant_revoke',
					{ grant_id: grant.id },
					alice_headers
				);
				assert.ok(revoked.ok, JSON.stringify(revoked.error));
				assert_not_held(
					await cross_rpc_call(t, rpc_path, 'cell_create', republish, bob_headers),
					'revoked grantee republish'
				);
				// The revoked grant also closes the clone path.
				const clone = await cross_rpc_call(
					t,
					rpc_path,
					'cell_clone',
					{ source_id: cell_id },
					bob_headers
				);
				assert.strictEqual(error_reason(clone), 'cell_not_found');
			}
		);

		test_if(
			capabilities.fact_serving,
			'a ref is a whole exact hash string — prose, markup, malformed, and uppercase are not refs',
			async () => {
				const fixture = await setup_test();
				const bob = await fixture.create_account({ username: 'ref_grammar_bob' });
				const t = fixture.fresh_transport();
				const exact = `blake3:${'0123456789abcdef'.repeat(4)}`;
				const not_refs = {
					prose: `see ${exact} for details`,
					markup: `![cover](${exact})`,
					padded: ` ${exact}`,
					newline: `${exact}\n`,
					short: 'blake3:zz',
					empty_digest: 'blake3:',
					long: `blake3:${'a'.repeat(65)}`,
					upper: `blake3:${'0123456789ABCDEF'.repeat(4)}`,
					other_algo: `sha256:${'a'.repeat(64)}`,
					keyed: { [exact]: 1 }
				};
				// The keeper's write is ungated, so the derived refs show the grammar
				// alone: none of the near-misses is a ref, the exact hash is.
				const keeper = fixture.create_session_headers();
				const none = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_create', { data: not_refs }, keeper),
					CellCreateOutput
				);
				assert.strictEqual(none.cell.refs, null, JSON.stringify(none.cell.refs));
				const one = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_create',
						{ data: { ...not_refs, file: exact } },
						keeper
					),
					CellCreateOutput
				);
				assert.deepStrictEqual(one.cell.refs, [exact]);
				// Not a ref, so a non-admin needs no holding to write it.
				const prose = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_create',
						{ data: not_refs },
						bob.create_session_headers()
					),
					CellCreateOutput
				);
				assert.strictEqual(prose.cell.refs, null);
			}
		);

		test_if(capabilities.fact_serving, 'ref admission answers after the 404 masks', async () => {
			const fixture = await setup_test();
			const alice = await fixture.create_account({ username: 'ref_mask_alice' });
			const bob = await fixture.create_account({ username: 'ref_mask_bob' });
			const t = fixture.fresh_transport();
			const bob_headers = bob.create_session_headers();
			const alices = await cross_put_fact(fixture, rpc_path, {
				content: 'alice hidden bytes',
				holder: alice.actor.id
			});
			const hidden = expect_output(
				await cross_rpc_call(
					t,
					rpc_path,
					'cell_create',
					{ data: { file: alices }, visibility: 'private' },
					alice.create_session_headers()
				),
				CellCreateOutput
			).cell.id;

			// An update of a hidden cell answers its mask whatever `data` names —
			// an unheld new ref or the hidden cell's own ref alike.
			for (const named of [UNSTORED_HASH, alices]) {
				const r = await cross_rpc_call(
					t,
					rpc_path,
					'cell_update',
					{ cell_id: hidden, data: { file: named } },
					bob_headers
				);
				assert.strictEqual(error_reason(r), 'cell_not_found', `update naming ${named}`);
			}
			const under = await cross_rpc_call(
				t,
				rpc_path,
				'cell_create',
				{ data: { file: UNSTORED_HASH }, parent_id: hidden },
				bob_headers
			);
			assert.strictEqual(error_reason(under), 'cell_not_found', 'create under a hidden parent');
			const clone = await cross_rpc_call(
				t,
				rpc_path,
				'cell_clone',
				{ source_id: hidden, with_data_patch: { extra: UNSTORED_HASH } },
				bob_headers
			);
			assert.strictEqual(error_reason(clone), 'cell_not_found', 'clone of a hidden source');
		});
	});
};
