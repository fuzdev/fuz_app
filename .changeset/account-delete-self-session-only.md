---
'@fuzdev/fuz_app': minor
---

break: `account_delete`'s self path is session-only

- a self-delete (`account_id` omitted or the caller's own) over an API token or a daemon token is refused with 403 `forbidden`, `data: {reason: 'credential_type_required', required_credential_types: ['session']}` — the dispatcher's own credential-gate refusal, byte for byte — before the keeper and last-admin guards run, so a leaked token can't end the account it belongs to (a keeper self-deleting over a token now hears `credential_type_required`, not `cannot_delete_keeper`)
- the input `account_id` is lowercased before any comparison, so an own id in uppercase is the self path too (the `Uuid` schema admits either case and Postgres matches either)
- an admin deleting another account still admits any credential; `account_delete_action_spec` declares no `credential_types`, so the gate is the handler's and does not show in the action manifest
- adds `credential_type_required_error(required_credential_types)` in `actions/perform_action.ts`, the builder the dispatcher's credential gate and the handler share
- the `account_lifecycle` cross-backend suite gains the case (a bearer self-delete → 403 with the session still live, the keeper's bearer deleting another account → 200, a session self-delete → 200), and the security conformance slate gains API-token and daemon-token self-delete rows in one equivalence group with the dispatcher's own session-only refusal
