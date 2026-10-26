---
'@fuzdev/fuz_app': minor
---

feat: `testing/cross_backend/spine_surface_constants.ts` adds `SPINE_WS_PATH`, `SPINE_ACCOUNT_PATH_PREFIX` and the `SPINE_ACCOUNT_{LOGIN,LOGOUT,PASSWORD,STATUS,SIGNUP,BOOTSTRAP}_PATH` routes, which the cross suites' RPC, WebSocket, audit-stream and account-route defaults now read (`/health` and the admin, fact and cell routes stay literals); `default_cross_process_setup` takes `signup_path` / `login_path` for the routes `fixture.create_account` mints through (defaults unchanged)
