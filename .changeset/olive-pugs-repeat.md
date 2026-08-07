---
'@fuzdev/fuz_app': minor
---

feat: run authority gates before input validation, and gate token-scoped capabilities declaratively

**Breaking on the wire.** Both dispatchers now run **401 → authorization phase →
403 → 400 → handler**, and `apply_route_specs` moved body validation behind the
post-authorization guards to match. A caller the credential / scope / role gates
refuse gets that denial instead of an `invalid_params` 400, which confirmed the
method exists and described how to call it to a channel that may never reach it.
Converges with the Rust spine. Consumers asserting 400-before-403 flip those
expectations.

Params and query still validate first, so the authorization phase reads the
`acting` selector raw (`parse_acting`, new export); a malformed one reads as
omitted and input validation rejects it a step later.

**Breaking: `AuthGuards.pre_validation` is now `pre_authorization`.** Both
phases run ahead of body validation now, so the names say which side of the
authorization phase a guard sits on. Consumers implementing a custom
`AuthGuardResolver` rename the returned field.

**Breaking: the REST credential-type gate moved to `pre_authorization`.**
`require_credential_types` never reads the resolved `RequestContext`, so it runs
ahead of actor resolution now, leaving `require_role` as the only
post-authorization guard — REST route specs run **presence → channel → scope →
role**, the order actions already used. Observable: a wrong-channel caller on a
multi-actor account gets `credential_type_required` (403) instead of
`actor_required` (400), no longer disclosing that the account has multiple
actors.

**New `auth.required_scope` on `RouteAuth`** names the capability a **narrowed**
api token's scope must admit, as the same `<section>:<id>` string the denial
reports back — `surface:<name>` (a non-RPC surface, refused to every narrowed
token) or `rpc:<method>` (one method, refused unless the token lists it).
Declaring it mounts `require_token_scope` (new export) as a `pre_authorization`
guard. The bare-hash fact read and the audit SSE stream declare it instead of
checking in-handler, so a narrowed token hears about its scope rather than about
a role it also lacks; `register_ws_endpoint` mounts the same guard ahead of its
role guard.

Registration throws on a malformed capability, on the field appearing on an
`ActionSpec` (the dispatcher derives it from the method there), and on a public
route declaring it.

**The identifier half is open** — name your own surface (`surface:file_store`)
with no registration, declaratively or via `token_scope_surface_denial` for a
surface that isn't a route spec. A surface name labels which surface refused and
decides nothing, and the sibling `rpc:` arm of the same field has always carried
arbitrary consumer method names.

**`create_action_route_spec` now gates the routes it derives.** A bridged route
never reaches `perform_action`, so the per-method scope check could not fire on
it — a bearer-reachable bridged route was a surface a narrowed token walked
straight through. The bridge derives `auth.required_scope: 'rpc:<method>'`, so a
token minted for the method reaches the route and one that wasn't gets the 403 it
would over RPC. Skipped for public actions; an explicit `required_scope` on
`options.auth` wins — pass a `surface:<name>` when bridging a stream or download,
where the whole-surface rule applies instead.

**New `TokenScopeRequiredError`**, derived at 403 from `auth.required_scope` and
unioned with the role / credential-type shapes. Without it the surface-gated
routes derived `PermissionError` alone, so the denial a narrowed token actually
receives went undocumented in the generated attack surface.

Regenerate your attack-surface snapshot if you mount the audit stream, the
bare-fact route, or any bridged action. If you mount your own bearer-reachable
surface, or rewrite a spine route's `auth` to admit a credential the shipped gate
refused, declare `required_scope` on those routes and audit them yourself — the
spine's census covers only the spine's own surfaces. See `docs/security.md`
§Token scoping.
