---
'@fuzdev/fuz_app': minor
---

break: `POST /bootstrap`'s `token` is at most `BOOTSTRAP_TOKEN_LENGTH_MAX` (4096) UTF-16 code units, the new constant in `auth/bootstrap_route_schema.ts` and the token file's cap (`MAX_SECURE_FILE_SIZE` bytes), where `BootstrapInput` had no maximum. A longer token, which could never match the file, is a malformed body, `400 invalid_request_body` before the window check or the token read, with no `bootstrap` failure audit row, where it was a `401 invalid_token` with one (or the closed window's `403` after bootstrap). The route surface's `token` gains `maxLength: 4096`. The Rust spine's `BOOTSTRAP_TOKEN_LENGTH_MAX` counts the same units.
