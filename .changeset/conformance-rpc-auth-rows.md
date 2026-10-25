---
'@fuzdev/fuz_app': minor
---

feat: `generate_rpc_auth_conformance_cases` (`testing/cross_backend/conformance_rpc_auth.ts`) turns each declared RPC method's auth into conformance rows — anonymous → 401, each refused credential channel → 403 `credential_type_required`, a role-less session → 403 `insufficient_permissions` — so `describe_conformance_table_tests` checks every method's live gate on every backend; `ROLE_GRANT_OFFER_HISTORY_LIMIT_MAX` exports the `role_grant_offer_history` page cap
