---
'@fuzdev/fuz_app': patch
---

fix: `actions/perform_action.ts` loads without the optional `hono` peer

- `http/ip_canonical.ts` parses addresses itself instead of importing `hono/utils/ipaddr`; since 0.142.0 the dispatcher keys its IP limiter through `rate_limit_ip_key`, so a consumer without `hono` couldn't load the cross-process suites (`Could not resolve "hono/utils/ipaddr"`)
- adds `parse_ipv4_bits` and `parse_ipv6_bits`, to the grammar of Rust's `IpAddr::from_str`; `canonicalize_ip` and `rate_limit_ip_key` answer as before
