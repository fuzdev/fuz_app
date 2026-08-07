---
'@fuzdev/fuz_app': minor
---

feat: run authority gates before input validation, and gate RPC-only-token surfaces declaratively

**Breaking on the wire.** Both dispatchers now run **401 → authorization phase →
403 → 400 → handler**, and `apply_route_specs` moved body validation behind the
post-authorization guards to match. A caller the credential / scope / role gates
refuse gets that denial instead of an `invalid_params` 400 — a 400 there
confirmed the method exists and described how to call it, to a channel that may
never reach it. Converges with the Rust spine, which validates handler-side.
Consumers asserting 400-before-403 flip those expectations.

Params and query still validate first, so the authorization phase reads the
`acting` selector raw (`parse_acting`, new export); a malformed one reads as
omitted and input validation rejects it a step later.

**Breaking: `AuthGuards.pre_validation` is now `pre_authorization`.** Both
phases run ahead of body validation now, so the names say which side of the
authorization phase a guard sits on. Consumers implementing a custom
`AuthGuardResolver` rename the returned field.

**Breaking: the REST credential-type gate moved to `pre_authorization`.**
`require_credential_types` never reads the resolved `RequestContext`, so it now
runs ahead of actor resolution, leaving `require_role` as the only
post-authorization guard. REST route specs therefore run **presence → channel →
scope → role**, the order actions already used. The observable: a wrong-channel
caller on a multi-actor account now gets `credential_type_required` (403)
instead of `actor_required` (400) — the coarser authority fact, and one that no
longer discloses that the account has multiple actors.

**New `auth.token_surface` on `RouteAuth`** names a route as one of the non-RPC
spine surfaces a **narrowed** token may not reach — token scoping's rule that a
narrowed token is RPC-only. Declaring it mounts `require_token_surface` (new
export) as a `pre_authorization` guard. The bare-hash fact read and the audit
SSE stream declare it instead of checking in-handler, so a narrowed token hears
about its scope rather than about a role it also lacks; `register_ws_endpoint`
mounts the same guard ahead of its role guard. Registration throws on an unknown
surface, on the field appearing on an `ActionSpec`, and on a public route
declaring it — each would be a control that silently does nothing.

**New `TokenScopeRequiredError`**, derived at 403 from `auth.token_surface` and
unioned with the role / credential-type shapes. Without it the two surface-gated
spine routes derived `PermissionError` alone, so the denial a narrowed token
actually receives went undocumented in the generated attack surface.

Consumers mounting the audit stream or bare-fact route regenerate their
attack-surface snapshot. Consumers that mount their own bearer-reachable
surface, or rewrite a spine route's `auth` to admit a credential the shipped
gate refused, audit those routes themselves — the spine's census covers only the
spine's own surfaces. `docs/security.md` gains a §Token scoping section.
