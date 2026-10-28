---
'@fuzdev/fuz_app': minor
---

fix: `setup_env_file` writes through the new pure `update_env_content`, the one env-file writer `update_env_variable` also builds on — a generated or consumer-supplied value is never interpreted as a `String.replace` pattern (`$'`, `$&`) and is quoted whenever it wouldn't read back bare (surrounding whitespace, a `#` comment marker, a leading quote, a line break); an empty `KEY=""` or `KEY= # comment` is backfilled too, and `SECRET_FUZ_COOKIE_KEYS` and the bootstrap token are generated in-process, so `setup_env_file`, `setup_bootstrap_token`, and `reset_bootstrap_token` no longer need `CommandDeps` or `openssl`
