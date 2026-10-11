---
'@fuzdev/fuz_app': minor
---

**breaking:** rename the fact-store error classes `PayloadTooLargeError` → `FactPayloadTooLargeError` and `StorageFullError` → `FactStorageFullError`, so they no longer collide with the `PayloadTooLargeError` HTTP error schema
