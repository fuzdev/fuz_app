---
'@fuzdev/fuz_app': minor
---

break: the RPC dispatcher refuses a call whose object `params` hold an own `__proto__` key at any depth — `invalid_params` (400) with `data.reason` `params_proto_key` (new `ERROR_PARAMS_PROTO_KEY`), on every method and transport, after the authority gates and the rate limit and before the input schema — as the Rust spine now does, instead of a loose input such as cell `data` or `policy` dropping a top-level one and storing a nested one (`json_has_own_proto_key`, new export of `http/schema_helpers.ts`, is the walk). Stored JSON holding the key is a prototype-pollution sink for a client that copies it back by assignment. A cell row that already stores one keeps it, and a write echoing it back is now refused. To migrate: find such rows with `SELECT id FROM cell WHERE position('"__proto__"' IN data::text) > 0 OR position('"__proto__"' IN coalesce(policy::text, '')) > 0`
