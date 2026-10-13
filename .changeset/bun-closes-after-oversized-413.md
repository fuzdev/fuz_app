---
'@fuzdev/fuz_app': minor
---

**breaking** fix: Bun closes the connection after an oversized-body `413`, like every other backend — Bun 1.4.3 honours the `Connection: close` the body limit sends, where an older Bun kept the connection and served the next request (correctly framed). Bun 1.4.3 is the tested floor: run Bun deployments and the Bun leg of the cross-backend suites at it or later

- testing: the `oversized_reject_closes_connection` capability is removed from `BackendCapabilities`, and `describe_body_size_smuggling_cross_tests` loses its `closes_connection` option and its keep-the-connection arm — every backend must answer the oversized `POST` + pipelined `GET` with at most one response. A consumer that sets the flag on a capabilities literal, or passes `closes_connection`, deletes both; a backend that keeps the connection after the `413` fails the suite
