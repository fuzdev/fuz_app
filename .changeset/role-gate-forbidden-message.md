---
'@fuzdev/fuz_app': minor
---

break: the RPC and WS role gate's 403 answers the message `forbidden`, as the Rust spine and the dispatcher's other authority gates do, instead of `requires role: <roles>`; the roles stay in `error.data.required_roles` beside `reason: 'insufficient_permissions'`
