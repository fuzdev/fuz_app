---
"@fuzdev/fuz_app": minor
---

**breaking** chore: the Bun and Deno testing server adapters import from `@hono/bun` and `@hono/deno`, now optional peer deps

- **breaking** `testing/cross_backend/testing_server_bun.ts` and
  `testing/cross_backend/testing_server_deno.ts` import from `@hono/bun` and
  `@hono/deno` instead of the deprecated `hono/bun` and `hono/deno` - install
  the one you use (both need `hono` >=4.13.9)
