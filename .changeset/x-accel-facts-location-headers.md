---
'@fuzdev/fuz_app': minor
---

**breaking** fix: `create_x_accel_config` tokenizes the nginx config as nginx does and refuses a config that passed before unless every location serving the facts prefix is a `location ^~` directly in a `server` block, holds only simple directives (no nested block, no `include`), and carries `internal;` plus `add_header X-Content-Type-Options "nosniff" always;` and `add_header Content-Security-Policy "default-src 'none'; sandbox" always;`; an `=` or regex location over the prefix is refused. New `server/fact_security_headers.ts` exports `FACT_X_CONTENT_TYPE_OPTIONS`, `FACT_CONTENT_SECURITY_POLICY`, `FACT_SECURITY_HEADERS`, and `fact_security_header_directives`
