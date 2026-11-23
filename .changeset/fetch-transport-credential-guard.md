---
'@fuzdev/fuz_app': minor
---

break: the cross-process fetch transport refuses to send its jar's cookie beside a request's own credential, and the keeper's daemon-token transport carries no cookie

- break: `create_fetch_transport`'s transport throws when a request names `Authorization` or `X-Daemon-Token`, names no `Cookie`, and the jar holds a cookie. The jar's cookie rode along before, so a dead bearer or daemon token beside it authenticated as the jar's principal (the keeper, on the fixture's transport) and the refusal a test expected was never reached. Send such a request over a cookie-free transport (`fixture.fresh_transport()`), or pass `Cookie` explicitly to send both credentials on purpose
- break: `BootstrappedBackendHandle.keeper_daemon_transport` is cookie-free: `bootstrap_backend`, `reconstruct_bootstrapped_handle` and the per-test fixture build it with no `initial_cookies`, so a daemon-token call carries that credential alone. A consumer building its own handle drops `initial_cookies` from that transport, as the `BootstrappedBackendHandle` example now does
