---
'@fuzdev/fuz_app': minor
---

**breaking** fix: `create_x_accel_config` refuses more at boot, as the Rust spine's `XAccelConfig` does — a redirect prefix not ending in exactly one `/`, a config whose only facts location sits below the prefix (`/_facts//` included — nginx compares location paths byte-for-byte), another `add_header` for a hardening header name beside its required line, `ssi` with any value but `off` anywhere, `more_set_headers` / `more_clear_headers` anywhere but inside a non-facts `location`, and blocks nested more than 64 deep (now a clean refusal, not a `RangeError`)
