---
'@fuzdev/fuz_app': minor
---

break: `CellActionDeps.validate_data` takes the cell's `kind` and returns nothing — `(kind, data) => void`, called with the input's `kind` on `cell_create`, the existing cell's on `cell_update`, and the source's on each row `cell_clone` writes — and the handlers store the caller's `data` as sent instead of the validator's return value, admitting refs on it too. To migrate: dispatch on the `kind` argument instead of on `data`, and drop the `return` — a validator that returned a parsed or defaulted value had that value stored, and now the input is, so apply any normalization on the client
