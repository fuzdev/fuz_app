---
'@fuzdev/fuz_app': minor
---

break: `describe_rpc_round_trip_tests` and `describe_round_trip_validation` fail a 401 to any non-public call that reads `authentication_required` or names no reason (`is_unauthenticated_refusal` in `testing/integration_helpers.ts`), naming the method or route and the principal it called as — the call carried a credential its auth admits, so such a 401 means that credential stopped working, which used to pass as a refusal and left every later call's coverage vacuous; a handler's own 401 reason on an authenticated call (`invalid_credentials`) still passes; the principal choice is shared by both suites (`pick_auth_principal` / `to_principal_headers`, `AuthPrincipal`; `pick_rpc_auth` and `assert_rpc_authenticated` in `testing/rpc_round_trip.ts`)
