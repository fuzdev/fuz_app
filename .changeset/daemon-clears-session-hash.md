---
'@fuzdev/fuz_app': minor
---

fix: a valid daemon token that overrides a session cookie sent beside it sets `AUTH_SESSION_TOKEN_HASH_KEY` to `null`, as it already did the API token id and the deadline, so a layer reading the raw key no longer sees the overridden session's hash (the Rust spine never reads the cookie on a daemon request); the audit stream keys its registration off `get_resolved_auth`
