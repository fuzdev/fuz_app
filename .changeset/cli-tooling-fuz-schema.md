---
'@fuzdev/fuz_app': minor
---

**breaking** feat: `load_config` in `cli/config.ts` takes a `@fuzdev/fuz_schema` schema instead of a Zod schema; `DaemonInfo` in `cli/daemon.ts` is a fuz_schema schema, so `DaemonInfo.parse`/`safeParse` become `parse_or_throw(DaemonInfo, …)`/`parse(DaemonInfo, …)` from `@fuzdev/fuz_schema/schema.ts`; the invalid-file warnings list issues as `format_issue` writes them
