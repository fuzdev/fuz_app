---
'@fuzdev/fuz_app': minor
---

break: `role_grant_offer_create` is session-only (`credential_types: ['session']`, beside `role_grant_offer_accept`) — an API or daemon token is refused with 403 `ERROR_CREDENTIAL_TYPE_REQUIRED` before the handler, writing no offer and no audit row — since a leaked bearer could offer a role to an account its holder controls, whose own-session accept left a grant outliving the token, and under an `authorize` callback that delegates offering every scoped holder's token was a role-minting credential. To migrate: drive offers from a browser session; a script conferring roles uses `role_grant_assign` (admin-gated, narrowable with a token scoped to it) instead
