---
'@fuzdev/fuz_app': minor
---

break: `SetupLogger` requires `warn`; feat: `seed_dev_account` warns when it leaves bootstrap closed with no live keeper or admin

- break: `SetupLogger` has a required `warn(msg)`, which `default_setup_logger` writes to `console.warn` as `  [warn] msg`. To migrate: add `warn` to a hand-written `SetupLogger`
- feat: `seed_dev_account` logs one `warn` when its transaction commits a database that is bootstrapped (the seed flips `bootstrap_lock`) with no live holder of the global `keeper` role, of the global `admin` role, or of both, naming each missing role. Bootstrap then refuses, so nothing will grant it; the line says to seed an account with `roles: ['keeper', 'admin']` or reset the database
