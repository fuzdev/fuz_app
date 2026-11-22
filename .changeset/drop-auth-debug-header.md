---
'@fuzdev/fuz_app': minor
---

break: the bearer and daemon-token legs no longer send the DEV-only `X-Fuz-Auth-Debug` header on a browser-context discard

- break: DEV builds no longer send `X-Fuz-Auth-Debug`; a test or tool that read it reads the debug log instead (the line the Rust spine logs)
- the two spines now answer a discarded credential identically in DEV too
