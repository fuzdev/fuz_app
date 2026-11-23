---
'@fuzdev/fuz_app': minor
---

break: `query_audit_log` logs its drift on an injected logger; the RPC attack-surface stubs answer schema-valid outputs

- break: `query_audit_log` takes `AuditLogQueryDeps` (`QueryDeps` plus `log`) and logs an unknown `event_type` or a metadata mismatch with `deps.log.error`, where it called `console.error`. `query_accept_offer`, which writes its audit rows through it, takes the same deps. A direct caller passes its logger: `query_audit_log({db, log}, input)`; `AuditEmitter` and the auth cleanup pass theirs
- fix: the "correct auth passes" stubs `describe_rpc_attack_surface_tests` mounts answer a value generated to pass each action's output schema (`null` for a null output) instead of `null`, which failed every non-null output schema and logged a DEV output mismatch per action. An output the generator can't reach makes the stub throw, naming the action
