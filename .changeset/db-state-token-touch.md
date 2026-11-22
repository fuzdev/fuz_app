---
'@fuzdev/fuz_app': minor
---

break: the database diff compares a token's last use; `DB_STATE_UNCOMPARED_COLUMNS` is removed

- break: `DB_STATE_UNCOMPARED_COLUMNS` is removed; `normalize_db_state` compares every column now that the Rust spine's drain awaits its token touch — `api_token.last_used_ip` as it is, and `api_token.last_used_at` as `<set>` or `null`, outside the timestamp ranks, since the touch runs concurrently with its own request's transaction and neither spine orders it against that request's writes
- docs: `_testing_drain_effects`'s `tracked` is documented as the constant `true` both spines answer, kept until consumers are on a release whose `cross_drain_effects` no longer reads it
