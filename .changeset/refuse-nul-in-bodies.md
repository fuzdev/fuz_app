---
'@fuzdev/fuz_app': minor
---

break: U+0000 in a request body is refused on both spines, where Postgres refused it on write with a 500: in RPC `params` (POST, GET, WebSocket) it is `invalid_params` with `data.reason` `params_nul` (`ERROR_PARAMS_NUL`), after the authority gates and the rate limit and after the `params_proto_key` check; in a route's JSON body it is 400 `invalid_request_body`, ahead of the body schema. Any string or object key, at any depth, of the parsed value

break: `json_has_own_proto_key` is replaced by `scan_json_value` (`http/schema_helpers.ts`), one walk returning a `JsonValueScan` (`{proto_key, nul}`) — read `.proto_key` for the old answer
