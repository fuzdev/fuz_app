---
'@fuzdev/fuz_app': minor
---

fix: three bugs blocking consumer migration to the v0.33 admin RPC surface

- **Behavior change**: the `create_rpc_endpoint` dispatcher now treats a missing *or* explicit-null `params` field as `{}` for object input schemas (unchanged for `z.null()` inputs). Matches HTTP's "empty body = empty object" convention so callers of all-optional-object RPC methods can omit `params` on the wire. Visible to every RPC caller, not just tests — previously-rejected envelopes now pass validation with an empty object.
- `generate_valid_value` in `testing/schema_generators.ts` now satisfies fixed-length hex patterns (blake3 / sha256 / md5 style).
- `describe_standard_admin_integration_tests`: removed the "admin response schema validation" test block. It was a REST-era path-prefix carve that's now redundant (RPC method outputs validate via `describe_rpc_round_trip_tests`, REST admin routes via `describe_round_trip_validation`) and hung indefinitely when consumers wired `audit_log_sse: true` under `/api/admin/*` — the SSE body never parses as JSON. Consumers lose no coverage.
