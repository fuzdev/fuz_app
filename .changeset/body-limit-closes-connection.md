---
'@fuzdev/fuz_app': minor
---

fix: an oversized body is refused with `413` on `Content-Length`, without reading the request body, and the response carries `Connection: close` — `create_app_server`'s body limit is the new `http/body_limit.ts` (`create_body_limit_middleware`), which falls back to Hono's streaming `bodyLimit` only without a usable `Content-Length`. What the connection does next depends on the runtime: Node closes at once with the body unread, where `@hono/node-server` used to hold the connection for a drain window first; Deno closes once the declared body has arrived, as before (a client that withholds the body holds the connection open); Bun keeps the connection and serves the next request on it, correctly framed, as before

- testing: on a backend with `closes_connection: false` (`oversized_reject_closes_connection`, `false` for Bun), `describe_body_size_smuggling_cross_tests` now requires exactly two whole responses — the `413`, then one equal in status and body to the pipelined `GET` sent alone — so `rpc_path` must answer a bare `GET` with a stable status and body, and a backend that closes the connection after the `413` fails until the capability is `true`
