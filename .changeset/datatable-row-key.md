---
'@fuzdev/fuz_app': minor
---

break: `Datatable`'s `row_key` is a required accessor `(row: T) => PropertyKey` instead of an optional property name defaulting to `'id'`, and rows no longer fall back to index keys (a missing key throws in DEV) — `AdminAccounts` rows, which have no top-level `id`, now key by `row.account.id`, so per-row popovers and pending state stay with their account across a delete or refetch. To migrate: pass `row_key={(row) => row.id}`
