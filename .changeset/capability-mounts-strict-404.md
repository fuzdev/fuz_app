---
'@fuzdev/fuz_app': minor
---

break: `describe_capability_mounts_cross_tests` reads an unmounted route's `404` only as the spine's JSON `route_not_found` — a bodiless `404` under `/api` from a backend's own fallback now fails the unmounted control; a refused upgrade may still answer one, as a runtime that drops its body (`ws_refusal_body`) does
