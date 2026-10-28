---
'@fuzdev/fuz_app': minor
---

break: remove `CREDENTIAL_TYPES` / `CredentialType` from `hono_context.ts`, a copy of the builtin set. To migrate: import `BUILTIN_CREDENTIAL_TYPES` / `BuiltinCredentialType` from `auth/credential_type_schema.ts`
