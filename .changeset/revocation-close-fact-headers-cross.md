---
'@fuzdev/fuz_app': minor
---

test: `describe_cross_process_ws_tests` pins a close on token revoke, admin token revoke-all, logout, password change, token-cap eviction and purge; `describe_cross_process_sse_tests` on admin token revoke-all, logout, password change and purge; with new `logout_path` / `password_path` / `max_tokens` options; `describe_fact_serving_cross_tests` pins the fact hardening headers, `Cache-Control`, and bodyless masked 404s
