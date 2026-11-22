---
'@fuzdev/fuz_app': minor
---

break: `resolve_conformance_principal` moves to `testing/cross_backend/conformance_principal.ts`

- break: `resolve_conformance_principal`, `ResolvedConformancePrincipal` and `ConformancePrincipalConfig` are imported from `testing/cross_backend/conformance_principal.ts`, no longer `conformance_table.ts` — apart from the table's WebSocket leg, so a suite resolving principals over HTTP (`rpc_adversarial`) reaches no socket transport
