---
'@fuzdev/fuz_app': minor
---

Add request-scoped streaming primitives to `ActionContext` and `ActionSpec`:

- `ActionContext.notify(method, params)` — send a JSON-RPC notification to
  the request originator. HTTP RPC no-ops (DEV-mode warn); streaming
  transports route to the originating connection.
- `ActionContext.signal: AbortSignal` — fires on client disconnect. HTTP
  dispatcher ties it to `c.req.raw.signal`.
- `ActionSpec.streams?: string` — optional, names the notification method
  emitted as request-scoped progress. Transport-agnostic.
