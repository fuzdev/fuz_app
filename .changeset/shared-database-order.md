---
'@fuzdev/fuz_app': minor
---

break: the backend swap and both-live suites share one order type, `SharedDatabaseOrder`

- break: `BackendSwapOrder` (`testing/cross_backend/backend_swap.ts`) and `BackendBothLiveOrder` (`testing/cross_backend/backend_both_live.ts`) are replaced by one `SharedDatabaseOrder` in `testing/cross_backend/shared_database_backends.ts`, the same shape (`label`, `first`, `second`). To migrate: import `SharedDatabaseOrder` from `testing/cross_backend/shared_database_backends.ts` in place of either old name
