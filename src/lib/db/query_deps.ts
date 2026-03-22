/**
 * Shared query dependency type.
 *
 * All `query_*` functions take `deps: QueryDeps` as their first argument.
 * Widened per-function when additional capabilities are needed (e.g., `log` for token validation).
 *
 * @module
 */

import type {Db} from './db.js';

/** Base dependency for all query functions. */
export interface QueryDeps {
	db: Db;
}
