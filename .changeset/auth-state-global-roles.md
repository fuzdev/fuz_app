---
'@fuzdev/fuz_app': minor
---

**breaking** feat: `AuthState` answers role gates from global grants; the scope-blind `roles` is gone

- `AuthState` gains a global-role view: `global_roles` (a reactive `ReadonlySet<string>` — the roles of active grants whose `scope_id` is `null`), `has_global_role(role)`, and `is_admin` (a global `admin` grant). This is the rule the server's role gates apply (`has_scoped_role(ctx, role, null)`): a grant scoped to one resource confers its role there only, and a scoped `admin` grant confers nothing. Gate role-dependent UI on these — `auth.is_admin` for admin UI, `auth.has_global_role(role)` for an app role
- **breaking** `AuthState.roles` is removed. It listed the role of every active grant with the scope dropped, so `roles.includes('admin')` was true for an account whose only `admin` grant was scoped to one resource — admin UI for an account the server refuses. Replace a role gate with `is_admin` / `has_global_role(role)`; for the role names at every scope, map `active_role_grants`
- **breaking** for a subclass of `AuthState` that defines its own `is_admin`, `global_roles`, or `has_global_role`: under `noImplicitOverride` it no longer typechecks. Delete the member when it asks the same question (a hand-rolled `role === ROLE_ADMIN && scope_id === null` does), otherwise mark it `override`; a subclass getter over the base's `is_admin` or `global_roles` has to become a field
- `has_global_role(role_grants, role, now?)` (`auth/account_schema.ts`) is the same check as a pure function over any list of grants — an active grant of `role` with `scope_id === null`, where active is `is_role_grant_active`. Use it in place of a hand-rolled global-grant predicate
- fix: `AdminAccounts`' `+ role` button, which offers the role globally, is no longer hidden by a grant or pending offer of that role scoped to one resource — only by a global grant or a pending global offer. The test is the new `can_offer_global_role(entry, role)` (`ui/admin_accounts_state.svelte.ts`)
