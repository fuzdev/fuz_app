---
'@fuzdev/fuz_app': minor
---

fix(actions): tighten `FrontendWebsocketClient.request()` error contract to `ThrownJsonrpcError` with specific codes

- `FrontendWebsocketClient.request()` now rejects with `ThrownJsonrpcError` (not generic `Error`), carrying per-site codes: `unauthenticated`, `request_cancelled`, `queue_overflow`, `service_unavailable`, `internal_error`, or the peer's wire code verbatim. Callers branch on `error.code` instead of scraping `error.message`.
- Adds two codes: `queue_overflow` (-32009 → HTTP 429, client-side buffer) and `request_cancelled` (-32010 → HTTP 499, AbortSignal). 429 reverse-maps still resolve to server-side `rate_limited`.
- Breaking only for consumers matching on `error.constructor === Error` or scraping message substrings. `ThrownJsonrpcError extends Error`, so `instanceof Error` continues to work.
