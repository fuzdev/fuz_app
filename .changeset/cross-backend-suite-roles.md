---
'@fuzdev/fuz_app': minor
---

feat: the role-shaped cross suites take their role as an option, so a backend with only the builtin roles can run them

- `describe_cell_grant_role_cross_tests` takes `role` (default `CELL_EDITOR_ROLE`), which the `CELL_ROLE_HOLDER_USERNAME` holder must hold; `ROLE_ADMIN` throws, since an admin reaches every cell whatever its grants, and `ROLE_KEEPER` serves a backend with only the builtins; its options type is `CellGrantRoleCrossTestOptions`
- `describe_role_grant_offer_lifecycle_cross_tests` and `describe_role_grant_participation_cross_tests` take `role` (default `SPINE_PARTICIPANT_ROLE`, any admin-grantable role — `ROLE_ADMIN` for the builtins); the participation suite also takes `scope_kind` for its scoped-assign case (default `'space'`, `null` for a builtin role, `null` skips the case); `RoleGrantOfferLifecycleCrossTestOptions` is an interface over `RpcPathCrossSuiteOptions`
- `describe_spine_cross_suites` takes `suite_roles` (`SpineSuiteRoles`: `cell_grant`, `conferral`) and seeds `cell_grant_role`'s holder with the role it names
