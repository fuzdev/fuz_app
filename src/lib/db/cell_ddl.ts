/**
 * Cell PG schema.
 *
 * The universal content primitive: a single `cell` table whose `data` JSONB
 * is interpreted by view shape. Parent→child membership and named
 * relationships live in two sibling tables — `cell_item` (ordered
 * children, fractional-indexing keyed) and `cell_field` (named edges).
 * `refs text[]` carries `blake3:` fact hashes auto-extracted from `data`
 * by application code on every write.
 *
 * Soft delete via `deleted_at`. Most indexes are partial on
 * `deleted_at IS NULL` so active-cell queries skip tombstones.
 *
 * `path` is the global namespace axis — a partial unique index enforces
 * uniqueness across all active rows (PostgreSQL UNIQUE constraints don't
 * support WHERE clauses, so it's expressed as a partial unique index). It
 * additionally filters on `deleted_at IS NULL` so a soft-deleted cell
 * doesn't block reuse of its path. Path writes are admin-only at the
 * action layer; user-namespaced paths are a future extension.
 *
 * **Ownership columns** (`created_by`, `updated_by`) are nullable FKs to
 * `actor`: NULL = system origin (well-known cells, daemon/agent cells).
 * The non-admin authz path treats NULL `created_by` as admin-only via an
 * explicit equality check (`auth/cell_authorize.ts`).
 *
 * **Timestamp naming** (`created_at`, `updated_at`) aligns with fuz_app's
 * `_at`-everywhere convention used by `account`, `actor`, `audit_log`,
 * `role_grant`, etc.
 *
 * **Single-migration shape**: `full_cell_schema` creates the canonical
 * cell + cell_grant + cell_field + cell_item layout in one shot from the
 * live exported constants. The dormant `cell_history` table lives in the
 * separate `fuz_cell_history` namespace (`cell_history_ddl.ts`).
 *
 * @module
 */

import type { Db } from './db.ts';
import type { Migration, MigrationNamespace } from './migrate.ts';

/**
 * `cell_visibility` enum — access-control axis for a cell. Lives as a
 * top-level column (not inside `data`) because visibility is access
 * control, not content metadata. `cell_grant` is the other ACL surface;
 * keeping visibility as a peer column (not a JSON field) co-locates
 * access-control state and lets the planner reason about it directly.
 *
 * Ships with two states (`'private'`, `'public'`); a third (unlisted /
 * public-link) folds in via `ALTER TYPE` when public-link sharing lands.
 *
 * Wrapped in a `DO` block so the migration can replay idempotently —
 * `CREATE TYPE` has no `IF NOT EXISTS` variant in PostgreSQL.
 */
export const CELL_VISIBILITY_TYPE = `
DO $$ BEGIN
	CREATE TYPE cell_visibility AS ENUM ('private', 'public');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$`;

/**
 * `cell` table — universal content primitive: identity + content only.
 * Parent→child membership lives in `cell_item`; named relations live in
 * `cell_field`. Includes the `created_by` / `updated_by` ownership columns.
 *
 * `visibility` is the access-control axis — `private` (default) is
 * restricted to admin / owner / `cell_grant`-admitted callers; `public`
 * admits everyone, including unauthenticated visitors. Lives as a
 * top-level column so the auth predicate reads off the row directly
 * rather than reaching into `data`.
 *
 * `path` is the global namespace axis (no tenant/hub scoping) — globally
 * unique on active rows via `idx_cell_path_unique`.
 *
 * `kind` is the capability / identity axis — a nullable top-level column
 * (peer to `visibility` / `path`), **not** a field inside `data`. It is the
 * discriminator a creation authorizer gates on (see `auth/cell_actions.ts`
 * `CellCreateAuthorize`) and is **write-once**: set at INSERT and carried on
 * no update path, so a cell's kind is fixed at birth. Content stays
 * duck-typed in `data`; `kind` is a capability tag, not a content-type.
 *
 * `parent_id` / `root_id` are the **directory tree** (containment): `parent_id`
 * is the immediate container (nullable self-FK; `NULL` = a root), `root_id` is
 * the governing root denormalized for flat-subtree queries (`root_id =
 * parent.root_id ?? parent.id`, so a root has `NULL`). Both are set once at
 * create and immutable in v1 (carried on no update path). `moderation`
 * (nullable text — `pending` / `approved` / `rejected`; `NULL` = unmoderated)
 * is the approval-lifecycle marker, peer to `visibility` (a control field with
 * a non-author writer — see `auth/cell_actions.ts`), never inside `data`.
 */
export const CELL_SCHEMA = `
CREATE TABLE IF NOT EXISTS cell (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	data JSONB NOT NULL,
	kind TEXT,
	visibility cell_visibility NOT NULL DEFAULT 'private',
	path TEXT,
	refs TEXT[],
	parent_id UUID REFERENCES cell(id) ON DELETE SET NULL,
	root_id UUID REFERENCES cell(id) ON DELETE SET NULL,
	moderation TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	updated_at TIMESTAMPTZ,
	deleted_at TIMESTAMPTZ,
	created_by UUID REFERENCES actor(id) ON DELETE SET NULL,
	updated_by UUID REFERENCES actor(id) ON DELETE SET NULL
)`;

/**
 * Cell indexes — all active-only, partial on `deleted_at IS NULL`.
 *
 * - `idx_cell_active`: active-cell list/scan ordered by creation.
 * - `idx_cell_path_unique`: global `path` uniqueness + read-side path
 *   lookup. Partial on path + active so reused paths after soft delete are
 *   allowed.
 * - `idx_cell_kind`: the `cell_list` kind filter (`cell.kind = ?`) and
 *   kind-scoped scans. Active-only.
 * - `idx_cell_data`: shape-driven queries (`data @> ...`).
 * - `idx_cell_refs`: cells-by-fact discovery (cross-cell reference graph).
 * - `idx_cell_created_by`: "cells this actor created" queries.
 * - `idx_cell_root`: flat-subtree feed/scope queries by governing root
 *   (`cell.root_id = ?`). Active-only.
 * - `idx_cell_moderation_pending`: the moderation queue — pending
 *   contributions per governing root. Partial on `moderation = 'pending'`.
 *
 * Parent↔child membership and named relations live in sibling tables;
 * see `CELL_ITEM_INDEXES` / `CELL_FIELD_INDEXES` below.
 */
export const CELL_INDEXES: Array<string> = [
	`CREATE INDEX IF NOT EXISTS idx_cell_active ON cell(created_at)
		WHERE deleted_at IS NULL`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_cell_path_unique
		ON cell(path)
		WHERE path IS NOT NULL AND deleted_at IS NULL`,
	`CREATE INDEX IF NOT EXISTS idx_cell_kind ON cell(kind)
		WHERE deleted_at IS NULL`,
	`CREATE INDEX IF NOT EXISTS idx_cell_data ON cell USING gin(data)
		WHERE deleted_at IS NULL`,
	`CREATE INDEX IF NOT EXISTS idx_cell_refs ON cell USING gin(refs)
		WHERE refs IS NOT NULL AND deleted_at IS NULL`,
	`CREATE INDEX IF NOT EXISTS idx_cell_created_by ON cell(created_by)
		WHERE deleted_at IS NULL`,
	`CREATE INDEX IF NOT EXISTS idx_cell_root ON cell(root_id)
		WHERE deleted_at IS NULL`,
	`CREATE INDEX IF NOT EXISTS idx_cell_moderation_pending ON cell(root_id)
		WHERE moderation = 'pending'`
];

/**
 * `cell_grant` table — resource-side ACL for cells. Each row admits a
 * principal (actor or `(role, scope_id)`) at a `level` (`viewer` or
 * `editor`). Owner is implicit (`cell.created_by`); the table never carries
 * owner rows.
 *
 * The single-principal arm is actor-grain (`actor_id` FK); the other arm is
 * role-shaped (`(role, scope_id)`). The CHECK enforces exactly one arm.
 */
export const CELL_GRANT_SCHEMA = `
CREATE TABLE IF NOT EXISTS cell_grant (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	cell_id UUID NOT NULL REFERENCES cell(id) ON DELETE CASCADE,
	level TEXT NOT NULL CHECK (level IN ('viewer', 'editor')),
	actor_id UUID REFERENCES actor(id) ON DELETE CASCADE,
	role TEXT,
	scope_id UUID,
	granted_by UUID REFERENCES actor(id) ON DELETE SET NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	CHECK (
		(actor_id IS NOT NULL AND role IS NULL AND scope_id IS NULL) OR
		(actor_id IS NULL AND role IS NOT NULL)
	)
)`;

/**
 * `cell_grant` indexes.
 *
 * - `idx_cell_grant_cell`: forward lookup ("who has access to this cell?").
 * - `idx_cell_grant_actor`: reverse lookup ("which cells does this actor have access to?").
 * - `idx_cell_grant_role_scope`: reverse lookup for role-shaped principals.
 * - `idx_cell_grant_unique_actor`: prevents duplicate actor-shaped grants for the same cell.
 *   Re-granting updates `level` via UPSERT on this index.
 * - `idx_cell_grant_unique_role_scope`: same, for role-shaped grants.
 *   `NULLS NOT DISTINCT` so two rows with the same `(cell_id, role)` and
 *   `scope_id IS NULL` collide — without it, default NULL-distinct
 *   semantics would let duplicate null-scope role grants slip past the
 *   re-share UPSERT path. Requires PostgreSQL 15+ (pglite tracks PG 16).
 */
export const CELL_GRANT_INDEXES: Array<string> = [
	`CREATE INDEX IF NOT EXISTS idx_cell_grant_cell ON cell_grant(cell_id)`,
	`CREATE INDEX IF NOT EXISTS idx_cell_grant_actor
		ON cell_grant(actor_id) WHERE actor_id IS NOT NULL`,
	`CREATE INDEX IF NOT EXISTS idx_cell_grant_role_scope
		ON cell_grant(role, scope_id) WHERE role IS NOT NULL`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_cell_grant_unique_actor
		ON cell_grant(cell_id, actor_id) WHERE actor_id IS NOT NULL`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_cell_grant_unique_role_scope
		ON cell_grant(cell_id, role, scope_id) NULLS NOT DISTINCT
		WHERE role IS NOT NULL`
];

/**
 * `cell_field` table — named relation (`(source_id, name) → target_id`).
 * One target per name per source — JSON-object keys are unique. Multiplicity
 * is expressed by composition (`foo.tags = collection_cell` whose `items[]`
 * are the tags), not by allowing duplicate `(source_id, name)` rows.
 */
export const CELL_FIELD_SCHEMA = `
CREATE TABLE IF NOT EXISTS cell_field (
	source_id UUID NOT NULL REFERENCES cell(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	target_id UUID NOT NULL REFERENCES cell(id) ON DELETE CASCADE,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	PRIMARY KEY (source_id, name)
)`;

/**
 * `cell_field` indexes.
 *
 * - PK on `(source_id, name)` covers forward lookup ("what does this cell
 *   point to via field X?") and the per-source fields list.
 * - `idx_cell_field_target` covers reverse lookup ("which cells link to
 *   this target?").
 *
 * Soft-delete is filtered by JOIN at the read boundary; no partial indexes
 * here on `deleted_at` (would force index churn on cell soft-delete
 * toggles, and the join filter is sufficient).
 */
export const CELL_FIELD_INDEXES: Array<string> = [
	`CREATE INDEX IF NOT EXISTS idx_cell_field_target ON cell_field(target_id)`
];

/**
 * `cell_item` table — ordered child membership keyed by an opaque
 * fractional-indexing string. `(parent_id, position)` PK enforces one cell
 * per slot; the same `child_id` may appear at multiple positions (the
 * primitive is JSON-array-shaped — ordered multiset, not set). Domain
 * dedup rules ride on top in helpers.
 */
export const CELL_ITEM_SCHEMA = `
CREATE TABLE IF NOT EXISTS cell_item (
	parent_id UUID NOT NULL REFERENCES cell(id) ON DELETE CASCADE,
	position TEXT NOT NULL,
	child_id UUID NOT NULL REFERENCES cell(id) ON DELETE CASCADE,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	PRIMARY KEY (parent_id, position)
)`;

/**
 * `cell_item` indexes.
 *
 * - PK on `(parent_id, position)` covers ordered scans for the per-parent
 *   items list (`SELECT ... ORDER BY position`).
 * - `idx_cell_item_child` covers reverse lookup ("which parents contain
 *   this child?").
 */
export const CELL_ITEM_INDEXES: Array<string> = [
	`CREATE INDEX IF NOT EXISTS idx_cell_item_parent_position ON cell_item(parent_id, position)`,
	`CREATE INDEX IF NOT EXISTS idx_cell_item_child ON cell_item(child_id)`
];

/** Tables created by `CELL_MIGRATION_NS`, in drop order (children first). */
export const CELL_DROP_TABLES = ['cell_field', 'cell_item', 'cell_grant', 'cell'] as const;

/** Cell migrations. */
export const CELL_MIGRATIONS: Array<Migration> = [
	{
		name: 'full_cell_schema',
		up: async (db: Db): Promise<void> => {
			await db.query(CELL_VISIBILITY_TYPE);
			await db.query(CELL_SCHEMA);
			for (const sql of CELL_INDEXES) {
				await db.query(sql);
			}
			await db.query(CELL_GRANT_SCHEMA);
			for (const sql of CELL_GRANT_INDEXES) {
				await db.query(sql);
			}
			await db.query(CELL_FIELD_SCHEMA);
			for (const sql of CELL_FIELD_INDEXES) {
				await db.query(sql);
			}
			await db.query(CELL_ITEM_SCHEMA);
			for (const sql of CELL_ITEM_INDEXES) {
				await db.query(sql);
			}
		}
	}
];

/** Namespace identifier for cell migrations. */
export const CELL_MIGRATION_NAMESPACE = 'fuz_cell';

/** Migration namespace consumed by `run_migrations`. */
export const CELL_MIGRATION_NS: MigrationNamespace = {
	namespace: CELL_MIGRATION_NAMESPACE,
	migrations: CELL_MIGRATIONS
};
