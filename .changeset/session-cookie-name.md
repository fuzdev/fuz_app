---
'@fuzdev/fuz_app': minor
---

break: the session cookie is a bare `session_cookie_name: string`, in the Rust spine's shape

- break: `SessionOptions<TIdentity>` is gone — its `encode_identity` / `decode_identity` codec and its `max_age` with it; every `session_options: SessionOptions<string>` option (`AppServerOptions`, `AppServerContext`, `AuthMiddlewareOptions`, the account, signup and bootstrap route options, `BootstrapAccountOptions`, and the testing suites, setups and helpers) is `session_cookie_name: string`; pass the name `create_session_config(name)` was given
- break: `create_session_config` and `fuz_session_config` are removed; the default name is `SESSION_COOKIE_NAME` (`'fuz_session'`), as on Rust
- break: `session_cookie_header(value, options)` → `sign_session_cookie(keyring, session_token, cookie_name): Promise<string>`, which signs and formats; `clear_session_cookie_header(options)` → `format_session_clear_cookie(cookie_name)`
- break: `parse_session`, `process_session_cookie`, `ParsedSession` and `ProcessSessionResult` → `parse_session_from_cookies(cookie_lines, keyring, cookie_name, now_seconds?)`, answering `SessionCookieRead` — `{kind: 'absent'} | {kind: 'invalid'} | {kind: 'valid', cookie: SessionCookie}` with `SessionCookie` `{token, expires_at}`; `get_session_cookie` is removed (read the `Cookie` lines with it)
- break: `create_session_cookie_value(keyring, session_token, now_seconds?)` drops its options argument
- break: `create_capped_session({deps, account_id, max_sessions?})` takes no keyring or options and returns `{token, evicted}` (`CappedSession.token`, the raw session token) in place of the signed `cookie_value`; the caller signs with `sign_session_cookie`
- break: `create_session_middleware(keyring, session_cookie_name)`
- break: `check_bootstrap_status` → `is_bootstrap_available(deps, {token_store}): Promise<boolean>` (`CheckBootstrapStatusDeps` → `IsBootstrapAvailableDeps`); `create_app_server` builds the `BootstrapStatus` ref from it
- break: `BootstrapAccountSuccess` is `{ok, session_token, account, actor, set_cookie}`, the Rust `BootstrapSuccess`; the `POST /bootstrap` wire body is unchanged
- break: `create_app_server` no longer mints a sample cookie at assembly; it refuses a `session_cookie_name` that is no RFC 6265 cookie-name, as before
- break (testing): `CreateTestAccountWithCredentialsOptions`, `MintTestSessionOptions`, `TestAppServerOptions` and `CreateTestingActionsOptions` drop their unused session option (`CreateTestAppOptions` declares `session_cookie_name` itself); the `_testing_credential_read` reading schema `SessionCookieRead` is renamed `SessionCookieReadKind`, the name `SessionCookieRead` now `auth/session_cookie.ts`'s
- break (testing): `spine_session_options` is removed — the spine binaries use `SESSION_COOKIE_NAME`; `TestingCredentialReadDeps.session_options` → `session_cookie_name` (`create_testing_credential_read_action`)
- no wire bytes move: the cookie value, its attributes and `Max-Age` (`SESSION_AGE_MAX`) are as they were
