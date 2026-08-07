---
'@fuzdev/fuz_app': minor
---

fix: enforce token scope on the audit SSE stream

Rule 3 of token scoping — *a narrowed token reaches no non-RPC surface* — was
enforced at the bare-hash fact read and the WS upgrade but not at the audit-log
SSE stream, one of the four surfaces it names. That route is role-gated only and
a bearer satisfies a role gate, so a token scoped to a couple of RPC methods
could open the admin audit feed. `GET /audit/stream` now refuses it with the
same flat `token_scope_required` body as its siblings.

The three checks are now one guard, `token_scope_surface_denial(c, surface)`,
exported from `auth/request_context.ts`. A new `token_scope_surface_census` test
makes the set of credential-consuming surfaces an assertion — each classified as
resolving the scope, consulting it, or exempt with a reason — so an unreviewed
surface fails the suite instead of shipping ungated.

Testing surface:

- `ConformancePrincipal` gains `scoped_token`, a bearer minted with a narrowed
  scope, plus four conformance cases pinning `token_scope_required` and its
  `required_scope` on both spines.
- **Fixed**: the cross-process harness's `mint_account` called
  `account_token_create` without the now-required `scope`, failing every
  cross-process test that mints a secondary account. Consumers running
  cross-backend suites against the Rust spine need this fix.
