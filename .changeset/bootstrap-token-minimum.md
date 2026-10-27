---
'@fuzdev/fuz_app': minor
---

break: a bootstrap token under the new `BOOTSTRAP_TOKEN_MIN_BYTES` (32, counted after its one optional trailing LF) reads as unreadable, with an error log naming the file — `check_bootstrap_status` reports bootstrap unavailable and `bootstrap_account` answers `token_file_missing` — through the new `read_bootstrap_token` both use; an empty or `"\n"` file used to advertise an open window nothing could match, and a short token was guessable. To migrate: regenerate a short token file (`reset_bootstrap_token` writes 32 random bytes), and give `create_test_app_for_bootstrap` a `bootstrap_token` of at least that length
