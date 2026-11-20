---
'@fuzdev/fuz_app': minor
---

feat: bootstrap refuses a token file with more than one hard link

- feat: `create_file_bootstrap_token_store` reads the token with `{require_single_link: true}`. A burn unlinks one name, so a token file with a second hard link would stay readable under the other; it is now refused as unreadable, like a symlink or a permissive mode: at boot the window reads unavailable with a warning naming the link count, and a bootstrap request answers 403 `already_bootstrapped`; a link made after boot answers 404 `token_file_missing` once and closes the window — either way nothing is created and the file is left in place. Both spines refuse alike
- feat: `FsSecureReadDeps.read_secure_file(path, options?)` takes `SecureReadOptions` (`require_single_link`, `runtime/secure_file.ts`, with `assert_secure_link_count`); off by default, so every other secure read is unchanged — a hard-linked signing key still loads. A custom `FsSecureReadDeps` passed to the bootstrap token store must honor the option
- testing: `MockRuntime.mock_fs_links` sets a mock file's link count (one when unset); `create_mock_runtime`'s secure read honors the option
