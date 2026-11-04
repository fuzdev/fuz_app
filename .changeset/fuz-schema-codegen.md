---
'@fuzdev/fuz_app': patch
---

fix: action codegen reads a `@fuzdev/fuz_schema` spec: `generate_action_inputs_outputs` types a fuz_schema input or output as its output, `Infer<typeof …>`, beside `z.infer<typeof …>` for a Zod one, and adds `import type {Infer} from '@fuzdev/fuz_schema/schema.ts';` only when a fuz_schema schema is present and `import {z} from 'zod';` only when a Zod one is; the `FrontendActionsApi` signature detects a void or null input of either library by shape (`is_void_schema`, `is_null_schema`, where a fuz_schema `s.void` threw), and `action_input_is_optional` parses through `parse_any`; a schema of neither library throws naming the method. An all-Zod spec list generates the same text as before. A `z.void()` or `z.null()` under a wrapper (`z.void().optional()`) is no longer read as no input.
