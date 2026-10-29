---
'@fuzdev/fuz_app': minor
---

break: the cross-backend action manifest carries each method's input shape — `ActionManifestEntry` gains a required `input: 'void' | 'object'` (`'void'` for a `z.void()` input, read by `is_void_schema`), `action_manifest_entry` / `build_action_manifest` read `spec.input`, and `diff_action_manifests` reports an `input_differs` diff (`testing/cross_backend/action_manifest.ts`, `action_manifest_parity.ts`). To migrate: pass `input` to any hand-built `action_manifest_entry` spec and add `input` to hand-built `ActionManifestEntry` values; a Rust backend's `_testing_action_manifest` must emit `input` too (the Rust spine's `ActionSpec` declares it as `InputShape`)
