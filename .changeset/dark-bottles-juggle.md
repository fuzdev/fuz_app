---
'@fuzdev/fuz_app': minor
---

audit_log: `target_actor_id` column + actor-targetable offers + dispatcher-resolved acting actor

Authentication is account-only; authorization (acting actor + permits) is per-request, resolved by the route-spec wrapper / RPC dispatcher. Routes opt in via `acting?: ActingActor` on their input or permit-requiring auth (`role` / `keeper`). Account-grain routes (logout, password_change, account_verify) skip resolution and run with `RequestContext.actor: null`, so multi-actor accounts can hit them without picking a persona.

Schema

- `audit_log.target_actor_id UUID REFERENCES actor(id)` + index. Populated when the event subject is actor-bound (see `AuditLogEvent.target_actor_id` doc).
- `permit_offer.to_actor_id UUID REFERENCES actor(id)` + partial index. Set → only that actor accepts and offer-shape audit envelopes inherit it. Null → account-grain.
- `auth_session` and `api_token` carry no actor binding.

Breaking

- `RequestContext.actor` widens to `Actor | null`; `permits` is `[]` on account-grain contexts. `has_role` / `has_scoped_role` / `has_any_scoped_role` already null-tolerant.
- Auth middleware (`create_request_context_middleware`, `bearer_auth`, `daemon_token_middleware`) sets `c.var.account_id` + `CREDENTIAL_TYPE_KEY` only — no longer loads actor / permits or sets `REQUEST_CONTEXT_KEY`.
- `apply_route_specs` and `create_rpc_endpoint` gain an authorization phase before input validation. Per-route order: params → query → pre-validation auth (401) → authorization → post-authorization auth (403) → input validation → handler. `acting` is read from raw query (GET) or pre-parsed body (mutations); the parse result is cached on `c.var.cached_request_body` (`CACHED_REQUEST_BODY_KEY`) so input validation does not re-parse.
- Authorization-phase failures wrap per-transport. `apply_authorization_phase` returns `AuthorizationFailure = {status, body}`; REST + WS emit `body` directly via `c.json`, the RPC dispatcher folds into `{jsonrpc, id, error: {code, message, data: {reason, ...rest}}}` (400 → `invalid_params`, 500 → `internal_error`). Consumer RPC tests can collapse to `rpc_call_for_spec` and assert on `error.data.reason` / `error.data.available`.
- REST `wrap_error_catch` now emits the flat `ApiError` shape `{error: <reason>, message?, ...rest}` instead of a JSON-RPC envelope; `reason` derives from `err.data.reason` or falls back to `jsonrpc_error_code_to_name(err.code)`. RPC routes are unaffected — the dispatcher still wraps.
- `query_permit_find_active_role_for_actor` returns `{role, account_id}` (was `{role}`) — joins `actor` so `permit_revoke` drops the redundant lookup.
- **Behavior change**: role-gated REST routes with required input previously returned 400 `invalid_request_body` for unauthenticated callers; now return 401 `unauthenticated` (auth gate fires before body parsing).
- **Behavior change**: an authenticated multi-actor caller hitting an `acting`-declaring route with malformed JSON previously got 400 `invalid_json_body`; the authorization phase now runs first and treats the unreadable body as `acting: undefined`, so multi-actor accounts get 400 `actor_required` instead. Single-actor accounts still get `invalid_json_body` (resolution succeeds, input validation surfaces the parse error).
- Every fuz_app RPC action input that uses the caller's acting actor declares `acting?: ActingActor` (admin / permit_offer / account / self_service_role specs, except `account_verify`).
- `account_verify` (REST + RPC), `/logout`, `/password` are account-grain — handlers no longer read `ctx.actor`; audit emits drop `actor_id`.
- `query_accept_offer` requires `actor_id` (was picking silently); race-loser branch throws `PermitOfferAlreadyTerminalError` on actor mismatch (was returning the winner's permit row).
- `permit_offer_create` input: optional `to_actor_id?: Uuid`. New errors `permit_offer_actor_mismatch`, `permit_offer_actor_account_mismatch`.
- `RevokeForScopeResult.revoked` carries both `actor_id` and `account_id`.
- `permit_offer_accept` / `_decline` / `_supersede` and self-service `permit_grant` / `permit_revoke` audit envelopes populate both target columns.
- `query_first_actor_by_account` → `query_actors_by_account` + `query_actor_by_id`. Login is account-only.
- `testing/middleware.ts`: `mock_find_by_account` → `mock_find_actor_by_id` + `mock_find_actors_by_account`.

Additions

- `ActingActor = Uuid.optional()` from `account_schema.ts` — shared schema for the `acting` field; declaring it is the duck-typed trigger for the authorization phase.
- `resolve_acting_actor(deps, account_id, acting_actor_id)` — discriminated `{ok}` / `actor_required` / `actor_not_on_account` / `no_actors`.
- `ERROR_ACTOR_REQUIRED`, `ERROR_ACTOR_NOT_ON_ACCOUNT`, `ERROR_NO_ACTORS_ON_ACCOUNT`, `ERROR_ACCOUNT_VANISHED` in `error_schemas.ts`. `account_vanished` (500) marks torn-read account lookups; distinct from `no_actors_on_account` (500) which signals a config-level invariant violation.
- `rpc_actor_action(spec, handler)` from `actions/action_rpc.js` — type-level binder pinning `ctx.auth` to `RequestActorContext` for handlers that declare `acting` or require permits. Mirrors `rpc_action`; same runtime shape.
- `JSONRPC_ERROR_CODE_TO_NAME` + `jsonrpc_error_code_to_name(code)` from `http/jsonrpc_errors.js` — reverse lookup mapping `code` to its discriminant name (default `internal_error`).
- `IsActingAware` callback on `apply_route_specs` / `merge_error_schemas` / `generate_app_surface` so actor-resolution errors auto-derive onto declaring routes' error schemas.
- `emit_permit_target_event(ctx, auth, deps, {...})` — permit-shape audit-emit helper.
- Typed RPC client codegen surfaces `acting?: ActingActor` on every declaring method.

Consumer migration

- Add `acting?: ActingActor` to any input whose handler uses the acting actor (audit, permits, actor-keyed business logic). The dispatcher 400s `actor_required` on multi-actor accounts otherwise.
- Drop reads of `auth_session.active_actor_id` / `api_token.actor_id` — columns removed.
- Pass `actor_id` to `query_accept_offer`.
- Account-grain handlers drop `actor_id` from audit emits.
- Handlers that need an actor: declare `acting?` (dispatcher resolves) or call `require_request_context` + assert `ctx.actor !== null` (only safe on routes the dispatcher would have rejected without one).
- Add `to_actor_id` / `target_actor_id` to fixtures and round-trip schemas.
- Handle the new actor-targeted offer error codes.

Schema migration

Body-edits v0 (`full_auth_schema`) and v1 (`permit_offer_and_scoped_permits`) in place. Fresh DBs pick up the new shape; consumers on v0.54.0 must reset dev DB or hand-apply:

- `ALTER TABLE audit_log ADD COLUMN target_actor_id UUID REFERENCES actor(id) ON DELETE SET NULL` + `idx_audit_log_target_actor`
- `ALTER TABLE permit_offer ADD COLUMN to_actor_id UUID REFERENCES actor(id) ON DELETE CASCADE`
