---
'@fuzdev/fuz_app': minor
---

break: `query_cell_list`'s `CellListParams` takes the caller as one `viewer: CellViewer` in place of `viewer_actor_id`, `viewer_is_admin`, `caller_actor_id`, `caller_role_grant_roles` and `caller_role_grant_scope_ids`, so visibility and grant admission can no longer be read for two different callers; `query_cell_grants_for_caller_in_cells(deps, cell_ids, viewer)` takes the same `CellViewer` in place of the actor and the two role-grant arrays; `CellViewerSqlParams` drops `grant_actor_id`. To migrate: build the viewer with `cell_viewer_from_auth(auth)` (or pass `CELL_VIEWER_ANONYMOUS` / `CELL_VIEWER_UNRESTRICTED`)
