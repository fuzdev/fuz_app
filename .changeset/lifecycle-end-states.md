---
'@fuzdev/fuz_app': patch
---

testing: the cross-backend suites pin four lifecycle end states

- `account_lifecycle`: a session and an API token minted before a delete stay refused after the undelete, and a fresh login authenticates (gated on `account_lifecycle`); a password change ends every session and API token of the account while another account's session stays live, and only the new password logs in (ungated — it needs the REST login and password routes). The suite takes optional `login_path` / `password_path` options, defaulting to the spine's
- `role_grant_offer_lifecycle`: an accept after a decline or a retract answers 400 `role_grant_offer_terminal` and grants nothing; a replayed accept answers the first grant
- `token_lifetime`: a bearer sent beside a winning session is never looked up, and the request acts as the session's account
