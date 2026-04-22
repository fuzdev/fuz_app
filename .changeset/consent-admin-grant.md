---
'@fuzdev/fuz_app': minor
---

feat: admin grant_permit routes emit offers instead of direct grants

**BREAKING**: `POST /api/admin/accounts/:account_id/permits/grant` now
emits a `permit_offer` (pending recipient acceptance) instead of writing
an active permit. The response shape changes from
`{ok, permit: {id, role}}` to `{ok, offer: PermitOfferJson}`. A permit
row only exists after the recipient calls `permit_offer_accept`.
`query_grant_permit` still exists and is unchanged; keeper-path code
(bootstrap, migrations, recovery) continues to use it directly.

Additional changes:

- `AdminAccountEntryJson` gains a `pending_offers` field.
- `AdminRouteOptions.permit_offer_default_ttl_ms` — independent from
  `PermitOfferActionOptions.default_ttl_ms`, lets admin-issued offers
  carry a different TTL than consumer-issued offers.
- New error: 400 `offer_self_target` — admins can no longer no-op-grant
  themselves through the admin route.
- `permit_offer_create` audit event replaces the previous `permit_grant`
  event on the admin grant route. `permit_grant` still fires on accept,
  chained from the consumer RPC.

Consumer migration:

- Frontends hitting `/permits/grant` must handle `{ok, offer}` instead
  of `{ok, permit}`. Expect `permit_offer_received` WS notifications
  on the recipient side.
- Test suites asserting `body.permit` on the admin grant route must
  assert `body.offer` instead; any active-permit setup in tests should
  call `query_grant_permit` directly.

See `docs/security.md §Consent as an authorization property`.
