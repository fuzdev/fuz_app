---
'@fuzdev/fuz_app': minor
---

break: `create_app_server` refuses a `max_body_size` that is not a safe integer `0` or more at assembly, before acquiring anything — a `NaN` cap compared false against every length and silently admitted any body — and `create_body_limit_middleware` throws on the same values; `max_body_size: null` still disables the cap and now adds a security warning to the surface diagnostics, logged by the startup summary. To migrate: pass a whole byte count, or `null` where your routes cap their own bodies
