/**
 * Possession-gated cell ref admission — the gate `cell_create`, `cell_update`,
 * and `cell_clone` run on the fact refs their `data` introduces.
 *
 * Fact serving admits a read of a hash through any cell the reader can view
 * whose `refs` carry it, and refs derive from `data` alone
 * (`derive_cell_refs`). Without this gate anyone who can write a cell could
 * name any hash they had seen (in a URL, a header, an audit row) and serve its
 * bytes through their own cell — to the world, if the cell is public — and
 * read a fact's existence off the serve answer. So a write may introduce only
 * refs to facts its acting actor **holds**: a `fact_holder` row, recorded on
 * every put that names the actor, identical bytes put by a second actor
 * included.
 *
 * Twin of the Rust `fuz_cell_actions` `cell_ref_admission` module.
 *
 * @module
 */

import type { Json } from '@fuzdev/fuz_util/json.ts';

import { jsonrpc_errors } from '../http/jsonrpc_errors.ts';
import type { QueryDeps } from '../db/query_deps.ts';
import { derive_cell_refs } from '../db/cell_queries.ts';
import {
	query_fact_holder_table_exists,
	query_fact_holder_unheld
} from '../db/fact_holder_queries.ts';
import { has_scoped_role, type RequestActorContext } from './request_context.ts';
import { ROLE_ADMIN } from './role_schema.ts';
import { ERROR_CELL_REF_NOT_HELD } from './cell_action_specs.ts';

/** The refusal message — byte-identical with the Rust spine's. */
export const CELL_REF_NOT_HELD_MESSAGE = 'cell data references a fact the caller does not hold';

/**
 * Refuse a write whose `data` introduces a fact ref the caller does not hold.
 *
 * `new_refs = derive_cell_refs(data) \ base`, where `base` is what the write
 * already carries — `null` on `cell_create`, the cell's current refs on
 * `cell_update`, the source row's refs on each row `cell_clone` writes — so
 * keeping refs someone else introduced, or cloning a viewable cell's refs, is
 * admitted (the bytes were already readable through that cell). A global
 * admin is not gated; a scoped admin is. The check runs on the write's
 * transaction, only when `new_refs` is non-empty — a table probe, then one
 * holder lookup for every new ref at once — and answers from holder rows only:
 * an unheld hash reads the same whether or not a fact is stored under it.
 *
 * A database without the fact chain (a consumer that mounts the cell verbs but
 * no fact store) has no holders, so every new ref is refused there too —
 * checked first, since naming a missing table would abort the transaction.
 *
 * Runs as the last gate before the row is written: after the 404 masks, the
 * per-kind validator, and the create authorizer.
 *
 * @param deps - query deps on the write's transaction
 * @param auth - the acting caller
 * @param base - the refs the write already carries, `null` for none
 * @param data - the `data` the write stores
 * @throws ThrownJsonrpcError 403 `forbidden` with reason `cell_ref_not_held` when a new ref is unheld
 */
export const require_new_refs_held = async (
	deps: QueryDeps,
	auth: RequestActorContext,
	base: ReadonlyArray<string> | null,
	data: Json
): Promise<void> => {
	if (has_scoped_role(auth, ROLE_ADMIN, null)) return;
	const refs = derive_cell_refs(data);
	if (refs === null) return;
	const new_refs = base === null ? refs : refs.filter((r) => !base.includes(r));
	if (new_refs.length === 0) return;
	const all_held =
		(await query_fact_holder_table_exists(deps)) &&
		(await query_fact_holder_unheld(deps, auth.actor.id, new_refs)).length === 0;
	if (!all_held) {
		throw jsonrpc_errors.forbidden(CELL_REF_NOT_HELD_MESSAGE, {
			reason: ERROR_CELL_REF_NOT_HELD
		});
	}
};
