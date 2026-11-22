---
'@fuzdev/fuz_app': minor
---

break: signup audit rows name the new actor; the cross-backend differential compares the database each case leaves

- feat: `testing/cross_backend/db_state_diff.ts` — `create_db_state_probe(handle)` reads every table of a backend's database directly (a PostgreSQL `DATABASE_URL` the test process reaches) after draining its audit writes, `normalize_db_state` maps the rows onto a form two backends share when they wrote the same things (ids and generated usernames as positional placeholders numbered by a canonical walk — `DB_STATE_TABLES`, `DB_STATE_SORT_KEYS` — so references, `metadata` included, compare; tokens and digests as constants; a `password_hash` as its argon2 parameter prefix; an `expires_at` as its offset from the row's `created_at`, other timestamps as their rank; audit `seq` as an offset, beside how far the audit sequence moved, so a rolled-back insert shows; `DB_STATE_UNCOMPARED_COLUMNS` left out, each with its reason), and `diff_db_states` lists the differences under `db.`
- feat: `DifferentialBackend.db_state` — with a probe on both backends, `describe_differential_conformance_tests` adds each case's database differences to its answer's, matched by the same known-divergence ledger
- feat: `diff_differential_values` (`differential_normalize.ts`) — the leaf-path diff `diff_differential_responses` runs over bodies, for any normalized value
- feat: `GENERATED_USERNAME_PATTERN` (`cross_backend/setup.ts`) — matches the usernames `fixture.create_account()` generates
- break: a successful signup's `signup` audit row now sets `actor_id` to the new account's actor (it was `null`), as the Rust spine and `bootstrap` write it — an audit reader or filter keyed on `actor_id` sees signups it didn't before
