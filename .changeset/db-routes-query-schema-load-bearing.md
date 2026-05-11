---
'@fuzdev/fuz_app': minor
---

fix: make `GET /tables/:name` query schema load-bearing — `offset` / `limit` now coerce + clamp via Zod (`z.coerce.number().int()` + min/max/default), handler reads validated values via `get_route_query`. Garbage input (e.g. `?offset=abc`) now returns 400 `ERROR_INVALID_QUERY_PARAMS` instead of silently defaulting. Exports `DB_TABLE_ROWS_DEFAULT_LIMIT` (100) and `DB_TABLE_ROWS_LIMIT_MAX` (1000).
