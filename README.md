# @fuzdev/fuz_app

> fullstack app library 🗝 pre-alpha ⚠️ do not use in production

fuz_app is a fullstack app library for
TypeScript, [Svelte](https://svelte.dev/), SvelteKit,
[Hono](https://hono.dev/), and [PostgreSQL](https://www.postgresql.org/)
with [PGlite](https://pglite.dev/) for embedded targets.
It provides auth, sessions, accounts, database integration, middleware, CLI utilities, and more,
the goal being an excellent and flexible whole-stack experience
for developers, operators, and end-users.

fuz_app supports deploying with Deno, Node, and Bun,
to servers, static websites, and local-first binaries, with more to come,
eventually with compatible alternatives written in Rust.

For more see the <a href="https://github.com/fuzdev/fuz_app/discussions">discussions</a>.
fuz_app is part of the Fuz stack
([fuz.dev](https://www.fuz.dev/), [@fuzdev](https://github.com/fuzdev)).

> ⚠️ This is a pre-alpha release, not ready for production.
> There are no known security vulnerabilities,
> and security has been \_the\_ primary focus for the initial release,
> but it shouldn't be trusted until audited.

## Usage

```bash
npm i -D @fuzdev/fuz_app
```

Some projects using fuz_app are in progress and will be open source soon.
Usage currently looks something like this:

```ts
import {create_app_backend} from '@fuzdev/fuz_app/server/app_backend.js';
import {create_app_server} from '@fuzdev/fuz_app/server/app_server.js';

const backend = await create_app_backend({...});

const {app} = await create_app_server({backend, ...});

Deno.serve({port: PORT, hostname: HOST}, app.fetch);
```

See [CLAUDE.md](CLAUDE.md) for more usage patterns and the AI-generated docs.

## License

[MIT](LICENSE)
