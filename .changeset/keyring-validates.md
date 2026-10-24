---
'@fuzdev/fuz_app': minor
---

**breaking** fix: `create_keyring` validates its keys and decodes cookie signatures strictly

- `create_keyring(value)` returns `{ok: true, keyring}` or `{ok: false, errors}` and refuses a value with no key or any key shorter than 32 characters, the Rust spine's `Keyring::new` rule; it was unvalidated and returned `Keyring | null`
- `create_validated_keyring` and `ValidatedKeyringResult` are removed: call `create_keyring` (type `CreateKeyringResult`); `validate_keyring` stays
- a cookie signature must be the exact padded standard base64 of the 32-byte MAC (43 characters then one `=`, no whitespace, no non-zero trailing bits), as on the Rust spine; `atob`'s other spellings of the same MAC no longer verify
- a session cookie whose `expires_at` is all digits but past `u64::MAX` no longer parses, as on the Rust spine
- add `describe_session_cookie_codec_cross_tests` (`testing/cross_backend/session_cookie_codec.ts`), a cross-backend suite that signs cookie variants with the backend's keyring and asserts each spine accepts one spelling
