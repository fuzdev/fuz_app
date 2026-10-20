/**
 * The page bound the two relation lists share — `cell_field_list` and
 * `cell_item_list`, forward and reverse alike. A page is up to `limit` edges
 * whose other end the caller can view. Both are public reads, so an omitted
 * `limit` is the default page, never unbounded: anyone can pad a public
 * cell's inbound links, and the reverse lists have no cursor.
 *
 * Twin of the Rust spine's `CELL_RELATION_LIST_LIMIT_MAX` /
 * `CELL_RELATION_LIST_LIMIT_DEFAULT`.
 *
 * @module
 */

import { z } from 'zod';

/** Cap on a relation-list page, forward and reverse alike. */
export const CELL_RELATION_LIST_LIMIT_MAX = 500;

/** The page size a relation list that omits `limit` gets, forward and reverse alike. */
export const CELL_RELATION_LIST_LIMIT_DEFAULT = 50;

/** The `limit` input of `cell_field_list` and `cell_item_list`. */
export const CellRelationListLimit = z
	.number()
	.int()
	.positive()
	.max(CELL_RELATION_LIST_LIMIT_MAX)
	.optional()
	.meta({
		description: `The most edges a page holds, each one whose other end the caller can view — forward and reverse alike: default ${CELL_RELATION_LIST_LIMIT_DEFAULT}, max ${CELL_RELATION_LIST_LIMIT_MAX}.`
	});
