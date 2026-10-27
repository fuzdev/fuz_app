---
'@fuzdev/fuz_app': patch
---

fix: `describe_differential_conformance_tests` sends every HTTP request with `accept-encoding: identity` (the new `DIFFERENTIAL_REQUEST_HEADERS`), so a backend runtime that compresses for a request accepting gzip — `Deno.serve`, against Node's `fetch` default — no longer reads as a `content-encoding` and `vary` difference on every case against one that doesn't; `send_conformance_case` takes the new `request_headers` option, sent on the HTTP request beneath the principal's headers, which win on a name clash. To migrate: delete any known-divergence entry tracking a `content-encoding` / `vary` difference — it now fails as closed.
