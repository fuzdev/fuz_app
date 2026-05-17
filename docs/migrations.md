# Migrations

NOTE: AI-generated

Operator runbook for the identity-tracked migration runner in `db/migrate.ts`.
For the auth-namespace migration list see `auth/migrations.ts`. For the
subsystem map see ../src/lib/auth/CLAUDE.md.

## Schema stability

**Pre-stable: append-only is NOT the rule today.** Migration bodies, names,
and positions can change between versions; consumers upgrading across a
schema change drop and re-bootstrap their dev/test databases. Bias toward
editing existing migration entries rather than appending patch migrations.

Once the schema is declared stable a hard append-only-after-publish rule will
apply and the cliff will be called out in that release's notes.

## Runner contract

`schema_version` stores one row per applied migration, keyed by
`(namespace, name)` with a monotonically-increasing per-namespace `sequence`
and `applied_at`. `run_migrations` reads applied rows ordered by `sequence`,
then enforces:

1. **Length check first.** If `applied.length > code.length`, throw
   `binary-older-than-db` listing the unknown names. Short-circuits before
   name verify so a binary-older case with a rename in the overlap doesn't
   fire `name-divergence-at-N` and send the operator chasing a phantom
   source revert.
2. **Name-prefix verify.** For each `i < applied.length`, assert
   `applied[i].name === code[i].name`; mismatch throws `name-divergence-at-N`
   with `at_index`.
3. **Run the pending tail** (`code[applied.length..]`) inside a single chain
   transaction; each `INSERT` uses `sequence = max(sequence) + 1`.

`MigrationError` is the only error class thrown from `run_migrations` and
`baseline`; branch on `.kind` (never on message text). Kinds:
`binary-older-than-db`, `name-divergence-at-N`, `old-tracker-shape`,
`migration-failed`, `baseline-name-not-in-code`, `baseline-name-out-of-order`,
`baseline-namespace-already-populated`.

`baseline(db, ns, names)` is the only sanctioned non-execution path — INSERTs
tracker rows for a name-prefix of `ns.migrations` without running their `up`
functions. Used to promote an existing schema into the new tracker (e.g.
after a tracker-shape upgrade). Per-namespace populated guard lets multi-call
cutover scripts resume after partial failure. `baseline()` does **not**
verify the schema actually matches what the named migrations would have
produced — pair with a schema-assertion script post-baseline.

There is **no programmatic bypass on the main `run_migrations` path** — no
`--force`, no `skip_verification`. If you need to deviate, reach for
`baseline()` (named, narrow) or direct SQL on the tracker (operator
explicitly states intent).

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

A `set_applied()` / `rename_applied()` helper was considered and rejected —
even one sanctioned bypass that doesn't name the operator's intent invites
use as a regular tool. Direct SQL forces the operator to consciously violate
the contract.
