---
'@fuzdev/fuz_app': minor
---

**breaking** fix: `create_x_accel_config` refuses more nginx configs at boot, matching the Rust `XAccelConfig`

- the redirect prefix must end in exactly one `/` (`/_facts/`, not `/_facts` or `/_facts//`)
- a location must sit exactly at the prefix (`/_facts` or `/_facts/`); one only below it, `/_facts//` included, no longer satisfies the check — nginx compares location paths byte for byte
- the facts location may set `X-Content-Type-Options` and `Content-Security-Policy` only with their required lines: another `add_header` for either name, in any case, is refused
- `ssi` with any value but `off` is refused anywhere in the config, and `more_set_headers` / `more_clear_headers` everywhere except inside a location that doesn't serve the prefix
- blocks nested more than 64 deep are refused as a parse error instead of throwing `RangeError`
- `validate_facts_internal_location` reports the same errors
- the `FUZ_FACTS_X_ACCEL_REDIRECT_PREFIX` env description says the prefix ends in `/`
