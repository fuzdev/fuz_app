---
'@fuzdev/fuz_app': minor
---

break: a JSON body or frame the Rust spine's `serde_json` refuses is refused on the TS spine too — an escaped lone surrogate in a string or a key, a number out of `f64` range (`1e400`), nesting 128 deep or more: `invalid_json_body` on a route, `parse_error` on the RPC POST body and a WS frame, `invalid_params` on `GET /rpc`'s `params`; they were accepted and stored rewritten (U+FFFD, `null`) or failed on a `jsonb` write. `parse_json_text` and `read_json_body` (`http/json_text.ts`) are the reader

break: action codegen no longer emits the `ActionInputs` / `ActionOutputs` runtime consts, only the `ActionInputs`, `ActionCallInputs` and `ActionOutputs` interfaces — run `gro gen`, and import the two as types

break: a hand-built `RouteFail`'s `def` must be the definition at its own status and code (`RestErrorDef<TStatus, TCode>`)

break: `SchemaFieldInfo.base_type` is a `SchemaFieldBaseType`, the innermost fuz_schema kind: `'one_of'` and `'variant'` where it read `'enum'` and `'union'`

break: an origin carve-out that is a route template (`:param`, `{pattern}`, an inner `*`) throws at assembly — a carve-out matches a path exactly or by a trailing `/*`

fix: `route_ok` with a function or symbol value throws as a malformed result before the commit, where it answered an empty 200

fix: `peer/ping`'s default input is a frozen object, as `with_default` shares it across calls
