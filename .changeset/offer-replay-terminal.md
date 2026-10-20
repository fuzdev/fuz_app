---
'@fuzdev/fuz_app': minor
---

fix: a replayed offer accept confers nothing — terminal once its grant is revoked, silent while it stands

- `query_accept_offer` on an accepted offer whose grant was revoked, or is gone, throws `RoleGrantOfferAlreadyTerminalError`, so `role_grant_offer_accept` answers 400 `invalid_request` with reason `role_grant_offer_terminal` instead of `200` with the revoked grant's id (a missing grant used to answer 500)
- a replay of an accepted offer whose grant stands still answers `200` with the same `role_grant_id`, and no longer notifies the grantor again (`role_grant_offer_accepted`); it writes no audit row, as before
- `role_grant_offer_accept_action_spec` gains `rate_limit: 'account'`, matching `role_grant_offer_create`
- the `role_grant_participation` cross-backend suite gains the replay cases (same grant and no new audit rows while held, terminal after revoke)
