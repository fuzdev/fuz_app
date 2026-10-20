---
'@fuzdev/fuz_app': minor
---

break: `cell_field_list` and `cell_item_list` return a capped page of visible edges in either direction — omitting `limit` no longer returns everything

- a page is up to `limit` edges whose other end the caller can view: the view check runs in SQL before the limit, so edges to or from cells the caller can't see never crowd out ones it can (a page of private sources older than one public source used to leave an anonymous reverse page empty)
- an omitted `limit` is a page of `CELL_RELATION_LIST_LIMIT_DEFAULT` (50) edges, forward and reverse alike; `limit` still caps at `CELL_RELATION_LIST_LIMIT_MAX` (500). Both lists are public reads, and anyone can pad a public cell's inbound links, so no call reads them unbounded. A caller that wants more passes `limit`; the forward lists page on with `name_after` / `position_after`, and the reverse lists have no cursor
- adds `auth/cell_relation_list_limit.ts` with the two constants and `CellRelationListLimit`, the `limit` schema both list inputs share; its description no longer says "Forward only" or "Omit for unbounded"
- adds `db/cell_view_sql.ts`: `can_view_cell_sql`, the one SQL form of `can_view_cell` (`query_cell_list` now embeds it too), with `CellViewer`, `CELL_VIEWER_ANONYMOUS`, `CELL_VIEWER_UNRESTRICTED`, `caller_role_grants_cte`, and `cell_grant_admits_caller_sql`; `auth/cell_authorize.ts` gains `cell_viewer_from_auth`
- `query_cell_field_list_for_source` / `_for_target` and `query_cell_item_list_for_parent` / `_for_child` take a `CellViewer` after `deps` and return only the edges it can view; pass `CELL_VIEWER_UNRESTRICTED` for a read that filters nothing
- the reverse lists order the oldest edge first with the edge key as the tiebreak, so a page is stable
- `filter_visible_target_ids` now serves the `cell_get` bundle and the clone walk only, and reads just the view facts through the new `CELL_VIEW_COLUMNS` / `query_cell_view_load_many` (`db/cell_queries.ts`), never the cells' `data`; `can_view_cell` takes those facts (a full `CellRow` still fits)
- the Rust spine filters the same way and now honors `limit` on the reverse lists too (it used to ignore it), with the same default; the cross-backend suites pin the default page, an explicit `limit`, the refused `limit` values, the visible-edge page, the moderation arms through every list, and the reverse order on both spines
