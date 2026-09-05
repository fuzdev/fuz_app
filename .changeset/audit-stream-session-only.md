---
'@fuzdev/fuz_app': minor
---

fix: gate the audit SSE stream to the session channel, and bucket every credential gate as one

**`GET /audit/stream` declares `credential_types: ['session']`.** A bearer or
daemon token gets `403 {error: 'credential_type_required',
required_credential_types: ['session']}` instead of a stream — including a
narrowed token, which previously heard `token_scope_required`. Flip any test
asserting either. A cookie-authenticated stream client (the browser case,
and what `ui/audit_log_state.svelte.ts` does) is unaffected.

To run a bearer-authenticated stream client, do three things together: widen
the gate, key your SSE subscribers by api-token id, and add `token_revoke`
to `disconnect_event_types`. The route keeps
`required_scope: 'surface:audit_stream'`, which governs the widened channel.

**Test harness**

- `describe_adversarial_auth`'s `keeper routes reject session credential →
  403` block is now `credential-gated routes reject a disallowed credential
  → 403`, over every route declaring `auth.credential_types`, with a
  `(<credential type>)` suffix per case. Update `skip_routes` entries and
  reporter filters that matched the old name.
- The role blocks (`wrong role → 403`, `authenticated without role → 403`)
  now include role routes gated to the session channel. Both changes mean
  new cases on a surface with a non-keeper credential gate.
- `assert_role_routes_declare_403` covers every credential gate, not role +
  keeper. A role-less session-gated route missing a 403 schema now fails —
  derive it (any `auth.credential_types` derives one) or declare it on
  `RouteSpec.errors`.
- `select_auth_app` picks the credential channel before the role. A gate
  admitting neither `'session'` nor the keeper role now throws naming both
  instead of returning a session app the route refuses.

**Surface consumers**

- `surface_auth_summary` returns a `credential: Map<string, number>` and
  `routes_by_auth_type` emits `credential:<type>` keys. Role-less
  channel-gated routes — `POST /logout`, `POST /password`, the `account_*`
  credential-lifecycle actions — previously landed in `other`; read them
  there now. Exhaustive `switch`es over `RouteAuthCategory` need the arm.

**Added**

- `filter_credential_gated_routes` (`http/surface_query.ts`) — every route
  with a non-empty `auth.credential_types`; superset of
  `filter_keeper_routes`.
- `AuthTestApps.by_credential_type` — one keeper-role app per builtin
  credential type. `apps.keeper` is that map's `daemon_token` entry, the
  same `Hono` instance as before.
