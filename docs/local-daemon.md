# PGlite Local Daemon Pattern

NOTE: AI-generated

How to use fuz_app's auth stack with PGlite for local-first daemons
and single-user applications. See [security.md](security.md) for security
properties, credential types, and known limitations. See
[architecture.md](architecture.md) for DB initialization and session details.

## Overview

fuz_app's auth modules work with any database that satisfies the `Db`
interface (duck-typed for both `pg` and `@electric-sql/pglite`). For
local daemons that don't need a full Postgres server, PGlite provides
an embedded Postgres engine via WASM.

```
create_db('file:///path/to/db/')  →  PGlite file-based
create_db('memory://')            →  PGlite in-memory (tests)
create_db('postgres://...')       →  pg Pool (production servers)
```

## Setup

Use `create_app_backend` + `create_app_server` — the same two-step pattern
as full server apps. PGlite is auto-detected from the `database_url`:

```ts
import {create_app_backend} from '@fuzdev/fuz_app/server/app_backend.js';
import {create_app_server} from '@fuzdev/fuz_app/server/app_server.js';
import {create_session_config} from '@fuzdev/fuz_app/auth/session_cookie.js';
import {argon2_password_deps} from '@fuzdev/fuz_app/auth/password_argon2.js';
import {create_validated_keyring} from '@fuzdev/fuz_app/auth/keyring.js';
import {BaseServerEnv} from '@fuzdev/fuz_app/server/env.js';

// 1. Init backend — PGlite file-based DB, auth migrations run automatically
const keyring_result = create_validated_keyring(cookie_secret);
if (!keyring_result.ok) {
	throw new Error(`Invalid keyring: ${keyring_result.errors.join(', ')}`);
}
const backend = await create_app_backend({
	keyring: keyring_result.keyring,
	password: argon2_password_deps,
	database_url: `file://${db_dir}`,
	stat: async (p) => {
		/* ... */
	},
	read_file: (p) => Deno.readTextFile(p),
	delete_file: (p) => Deno.remove(p),
});

// 2. Assemble Hono app (auth middleware, routes, bootstrap — all handled)
const {app, close} = await create_app_server({
	backend,
	session_options: create_session_config('my_session'),
	allowed_origins: ['http://localhost:*'],
	proxy: {
		trusted_proxies: ['127.0.0.1', '::1'],
		get_connection_ip: (c) => getConnInfo(c).remote.address,
	},
	bootstrap: {
		token_path: `${app_dir}/config/auth_token`,
	},
	create_route_specs: (ctx) => [
		create_health_route_spec(),
		...prefix_route_specs('/api', my_routes(ctx)),
	],
	env_schema: BaseServerEnv,
	// event_specs defaults to [] when omitted
});
```

This gives you the full auth table set: `account`, `actor`, `permit`,
`auth_session`, `api_token`, `audit_log`, plus the `schema_version`
tracking table. Migrations are version-gated — safe to call on every
startup.

## Bootstrap Flow

Local daemons typically use a file-based bootstrap token:

1. **Init**: Generate a random token file at a known path (e.g., `~/.myapp/config/auth_token`)
2. **First run**: User opens the web UI, sees the bootstrap form
3. **Bootstrap**: User pastes the token + credentials → account created with keeper and admin permits, session cookie set
4. **Token consumed**: The file is deleted — bootstrap is one-shot

The `on_bootstrap` callback on the bootstrap options runs after account +
session creation. Use it for app-specific setup like generating CLI API tokens.

## Testing

Use in-memory PGlite for tests (`database_url: 'memory://'`):

```ts
import {create_test_app} from '@fuzdev/fuz_app/testing/app_server.js';

const {app, create_session_headers, create_account, cleanup} = await create_test_app({
	session_options: create_session_config('test_session'),
	create_route_specs: (ctx) => my_routes(ctx),
});

// create_test_app handles PGlite, migrations, and test defaults
afterAll(() => cleanup());
```

## When to Use This Pattern

**Good fit:**

- Local-first daemons with embedded auth
- Single-user desktop applications with a web UI
- Development/testing without a Postgres server
- CLI tools that serve a local web UI alongside their main process

**Not a good fit:**

- Multi-user production servers — use PostgreSQL for durability and concurrent access
- Horizontally scaled deployments — PGlite is single-process, in-memory rate limiters don't share state
- Workloads requiring concurrent writes from multiple processes

**Limitations:**

- PGlite WASM cold-start adds ~500-700ms on first connection (cached after)
- No WAL-based replication or point-in-time recovery
- File-based daemon tokens assume single-process — multi-process races are possible
- In-memory rate limiter state resets on restart
