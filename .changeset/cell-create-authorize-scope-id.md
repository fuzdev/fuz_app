---
'@fuzdev/fuz_app': minor
---

break: `CellCreateAuthorizeInput` drops its always-`null` `scope_id`, so a `CellCreateAuthorize.authorize` reads `{kind, data, parent_id, parent_kind, root_id, root_policy}`. To migrate: stop reading `scope_id` in a create authorizer
