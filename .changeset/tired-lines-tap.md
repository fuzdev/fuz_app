---
'@fuzdev/fuz_app': minor
---

fix: redact internal detail from production error responses

- omit Zod validation `issues` (RPC `error.data`, REST `issues`)
- mask raw `internal_error` exception messages
