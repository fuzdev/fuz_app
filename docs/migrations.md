# Migrations

NOTE: AI-generated

Operator runbook for the identity-tracked migration runner in `db/migrate.ts`.
For the auth-namespace migration list see `auth/migrations.ts`. For the
subsystem map see ../src/lib/auth/CLAUDE.md.

## Schema stability

**The rule differs per namespace** — which one applies depends on whether
consumers hold long-lived data in it.

**`fuz_auth` is frozen: append, never edit.** Consumers run deployed
databases on it, and an already-bootstrapped DB recorded the released
entries as applied — so editing a body is a silent no-op there: the DDL
never re-runs, the runner sees nothing new, and the shape the code expects
never lands. Every change ships as a new appended entry with idempotent DDL
(`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`), so a fresh
bootstrap and an old deployed DB converge. `auth/migrations.ts`'s module doc
carries the incident that set the rule. `db/schema_ready.ts` is the runtime
net when that discipline lapses.

**`fuz_facts` is frozen too**: `full_fact_schema`, then `fact_holder`, each
appended the same way. `fact_holder.actor_id` references `fuz_auth`'s `actor`
table, so the namespace runs after `fuz_auth` (`create_app_backend` already
runs `fuz_auth` ahead of every `migration_namespaces` entry; a standalone
runner orders it first).

**`fuz_cell` is pre-stable**: a single `full_cell_schema` entry, rewritten in
place when its shape changes, and consumers drop and re-bootstrap across the
change. When it takes on long-lived consumer data it joins the frozen set, and
the cliff will be called out in that release's notes.

Every entry, frozen or not, is twinned by an identically named migration on
the Rust spine — the `_testing_migration_tracker` parity gate compares the
`(namespace, name, sequence)` rows so a consumer can swap implementations
over one database.

## Runner contract

The boot algorithm, the per-namespace advisory lock, `baseline()`, and the
`MigrationError` kinds are in ./architecture.md §Migrations — there is no
programmatic bypass of `run_migrations`.

## Operator recipes

Run with the service stopped — these bypass the advisory lock.

### Rename a migration

Coordinated code+SQL change, not just SQL. The order matters:

1. Stop the service. Disable auto-restart for the cutover window.
2. Run the SQL `UPDATE` first — old code on disk doesn't read `name`, so the
   old build keeps booting cleanly between this step and the next.
3. Deploy the build with the renamed migration in the code array.
4. Start the service — boot's name-prefix verify passes.

The bad order is "deploy code with new name, then SQL UPDATE" — boot fires
`name-divergence-at-N` and refuses to start in between.

```sql
UPDATE schema_version SET name = 'new_name'
 WHERE namespace = $ns AND name = 'old_name';
```

### Mark a single migration applied without running it

Extreme repair — prefer `baseline()` when promoting a whole prefix:

```sql
INSERT INTO schema_version (namespace, name, sequence, applied_at)
VALUES ($ns, $name,
        (SELECT COALESCE(MAX(sequence), -1) + 1
           FROM schema_version WHERE namespace = $ns),
        NOW());
```

### Reset a namespace

Drop tracker rows; idempotent migrations re-apply on next boot:

```sql
DELETE FROM schema_version WHERE namespace = $ns;
```

Tracker surgery is direct SQL by design — `schema_version` is one of
`http/db_routes.ts`'s `NON_DELETABLE_TABLES`, so the db-admin browser refuses it.

A `set_applied()` / `rename_applied()` helper was considered and rejected —
even one sanctioned bypass that doesn't name the operator's intent invites
use as a regular tool. Direct SQL forces the operator to consciously violate
the contract.
