---
'@fuzdev/fuz_app': minor
---

**breaking** chore: remove the unused `ws_round_trip.ts` helpers and move the spine env-var names to `spine_surface_constants.ts`

- testing: **breaking** `keeper_identity` and `build_broadcast_api` are removed from `testing/ws_round_trip.ts`. For the identity, pass `{credential_type: 'daemon_token', roles: [ROLE_KEEPER]}` to `WsTestHarness.connect`; for the broadcast API, register the harness's `transport` on an `ActionDispatcher` and pass it to `create_broadcast_api` (`actions/broadcast_api.ts`)
- testing: **breaking** `LOGIN_RATE_LIMIT_ENABLED_ENV`, `ACTION_RATE_LIMIT_ENABLED_ENV`, and `ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV` move from `testing/cross_backend/default_backend_configs.ts`, and `TS_SPINE_DIR_ENV` from `testing/cross_backend/ts_spine_backend_config.ts`, to `testing/cross_backend/spine_surface_constants.ts`; the values are unchanged
