---
'@fuzdev/fuz_app': minor
---

**breaking** fix: peer '@fuzdev/pglet-wasm' `>=0.1.2`, whose server-runtime `transaction()` queues a concurrent top-level call instead of rejecting it — concurrent fact puts on pglet no longer fail
