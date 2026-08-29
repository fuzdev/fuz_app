---
'@fuzdev/fuz_app': minor
---

feat: harden secret-file handling (breaking)

Three related changes, all wire-invisible:

- **The bootstrap-token read is hardened** — the P1 twin of the Rust spine's
  `fuz_sys::secure_file::load_secure_file`. `AppDeps` /
  `CreateAppBackendOptions` replace `stat` + `read_text_file` (both existed
  only for bootstrap) with one `read_secure_file` capability, implemented on
  every runtime (`FsSecureReadDeps`): symlinks are refused (`O_NOFOLLOW` on
  Node), any group/other-accessible mode is refused (must be `0600`/`0400`,
  checked on the open descriptor), and a 4 KiB cap bounds the read. The
  boot-time availability probe (`check_bootstrap_status`) now reads through
  the same capability, so it can never report a window the request-time read
  refuses. Operator-visible: a hand-placed `0644` token now reports
  bootstrap unavailable with a logged reason (deployed hosts are already
  `0600`).
- **The daemon-token producer moved to `testing/daemon_token_rotation.ts`**
  (behind `assert_dev_env`). No production assembly mints daemon tokens —
  the credential's only remaining role is the cross-process harness's keeper
  channel — so `write_daemon_token` / `start_daemon_token_rotation` leave
  `auth/daemon_token_middleware.ts`, which keeps only the credential
  consumer. The optional `chmod` dep is gone: the token file is written
  atomically at mode `0600`.
- **`write_file_atomic` uses a unique exclusive temp** —
  `.{name}.tmp.{pid}.{counter}` with `O_EXCL` and an optional `{mode}`,
  so a crash-leftover temp can never be reopened `O_TRUNC` with a stale
  permissive mode and published by the rename. `FsWriteDeps.write_text_file`
  gains `{mode?, exclusive?}` options and `mkdir` gains `mode`.
  `dev/setup.ts` drops the `set_permissions?` callbacks — the `.env` and
  bootstrap-token writes now create at `0600` (state dir `0700`) directly,
  so consumers delete their `Deno.chmod` wrappers.
