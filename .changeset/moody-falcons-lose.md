---
'@fuzdev/fuz_app': minor
---

- admin revoke enforces `web_grantable` (symmetric with grant — blocks revoking keeper permits via the web)
- admin grant/revoke emit `permit_grant`/`permit_revoke` audit events with `outcome='failure'` when `web_grantable` is denied
- `permit_grant` metadata `permit_id` is now optional (absent on failure paths where no permit row is created)
- login per-account rate limit keyed by canonical `account.id` (prevents username/email alternation bypass)
- SSE: `session_revoke` closes only the revoked session's stream (new `AUTH_SESSION_TOKEN_HASH_KEY` + `SubscriberRegistry` scope/groups split); ignores `outcome=failure` events; new `max_per_scope` cap (default 10 tabs per session)
- nginx validator recognizes location modifiers (`=`, `~`, `~*`, `^~`) and errors when no `/api` block is found
