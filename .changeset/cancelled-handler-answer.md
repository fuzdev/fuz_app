---
'@fuzdev/fuz_app': minor
---

break: a throw after the request's `signal` aborted answers `request_cancelled`

- break: `perform_action` answers a throw that is no `ThrownJsonrpcError`, made once the request's `ctx.signal` has aborted (a WS `cancel`, the socket closing, an HTTP client gone), with `request_cancelled` (-32010, 499), in the authorization phase and the handler alike, where it logged `unhandled action handler error: …` at `error` and answered a masked `internal_error` (500). A throw that is the cancellation itself (the signal's reason, as `ctx.signal.throwIfAborted()` throws, or an `AbortError`) is logged at `debug`; any other throw after the abort may be a fault that landed after the cancel and is logged at `warn`. A test asserting the old error line or `internal_error` there drops it. A throw with the signal live is unchanged
- fix: the Rust dispatcher answers a handler's `Err` as returned, so a Rust handler that bails with `internal_error` after a cancel still answers `internal_error` (logged where it is built); it traces an `Err` settled after its request was cancelled at `debug`
