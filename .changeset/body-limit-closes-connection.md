---
'@fuzdev/fuz_app': minor
---

**breaking** fix: an oversized-body `413` now closes the connection on every runtime — `create_app_server`'s body limit (new `http/body_limit.ts`, `create_body_limit_middleware`) refuses on `Content-Length` without reading the request body and answers `Connection: close`, falling back to Hono's streaming `bodyLimit` only without a usable `Content-Length`. Hono's `bodyLimit` read the body getter first, which made Deno and Bun drain the declared body and keep the socket alive, and left `@hono/node-server` to drain it whenever nothing read it

- testing: removed the `oversized_reject_closes_connection` capability — `describe_body_size_smuggling_cross_tests` drops its `closes_connection` option and requires at most one response on every backend
