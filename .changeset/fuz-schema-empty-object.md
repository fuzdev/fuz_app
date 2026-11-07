---
'@fuzdev/fuz_app': patch
---

deps: require `@fuzdev/fuz_schema` `^0.5.5`, so the empty `heartbeat` output types as `Record<string, never>`, not `{}`

- a consumer's regenerated `action_collections.ts` reads `Infer<typeof heartbeat_action_spec.output>`, which with fuz_schema 0.5.4 resolved to `{}` and failed `@typescript-eslint/no-generated-empty-object-type`; upgrade `@fuzdev/fuz_schema` to `^0.5.5` beside this release
