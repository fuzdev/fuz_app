---
'@fuzdev/fuz_app': minor
---

break: `_testing_drain_effects` answers `{ok: true}` — the constant `tracked: true` is gone from its output schema and handler, and `cross_drain_effects` requires exactly `{ok: true}` (an unknown key is refused); a consumer's Rust test server must answer the same (`fuz_testing`'s spec does), and a consumer still on a predecessor release refuses the new answer
