---
'@fuzdev/fuz_app': minor
---

break: `_testing_origin_check` moves to `testing/cross_backend/testing_origin_check.ts`

- `TestingOriginCheckInput`, `TestingOriginCheckOutput`, `run_testing_origin_check`, `testing_origin_check_action_spec`, and `create_testing_origin_check_action` move out of `testing/cross_backend/testing_reset_actions.ts`; import them from the new path
- the new module is hono-free, so `origin_conformance.ts` no longer pulls the in-process app server and a consumer without `hono` can run the origin conformance table
- exports `TESTING_ACTION_AUTH`, the shared `auth` of every `_testing_*` spec, from `testing/cross_backend/spine_surface_constants.ts`
