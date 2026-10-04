---
'@fuzdev/fuz_app': patch
---

test: `describe_cross_process_sse_tests` covers the per-session audit stream cap

A new case opens one audit-log stream past the cap on one session and
asserts only the oldest closes — the evict-oldest policy of
`AUDIT_LOG_SSE_MAX_PER_SCOPE`, which the Rust spine's `fuz_realtime`
`SseRegistry` now applies too. The suite takes a `max_per_scope` option for a
backend with a different cap (default `AUDIT_LOG_SSE_MAX_PER_SCOPE`); `null`, for
a backend with the cap disabled, skips the case.
