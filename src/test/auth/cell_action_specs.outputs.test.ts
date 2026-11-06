/**
 * The cell wire outputs refuse what neither spine writes: each row timestamp
 * is a `Timestamp`, `moderation` one of its three markers, `kind` within
 * `CELL_KIND_LENGTH_MAX`, a field's `name` a `CellFieldName`, a grant's
 * `role` a `RoleName`, and an audit row's `seq`, `event_type`, and `outcome`
 * those of `AuditLogEventJson`. Each case is a value the output took before
 * it was held to the rows both spines write.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { is, type AnySchema } from '@fuzdev/fuz_schema/schema.ts';

import { CELL_KIND_LENGTH_MAX, CellJson } from '#lib/auth/cell_action_specs.ts';
import { GrantJson } from '#lib/auth/cell_grant_action_specs.ts';
import { FieldJson } from '#lib/auth/cell_field_action_specs.ts';
import { ItemJson } from '#lib/auth/cell_item_action_specs.ts';
import { CellAuditEventJson } from '#lib/auth/cell_audit_action_specs.ts';

const ID = '3f8a1c2e-1234-4abc-9def-0123456789ab';
const AT = '2026-11-06T12:00:00Z';

/** Not a `Timestamp`: Postgres's own text form, which neither spine sends. */
const PG_AT = '2026-11-06 12:00:00+00';

const cell = {
	id: ID,
	path: null,
	data: {},
	kind: 'post',
	visibility: 'private',
	refs: null,
	parent_id: null,
	root_id: null,
	moderation: null,
	policy: null,
	created_by: ID,
	updated_by: null,
	created_at: AT,
	updated_at: AT,
	deleted_at: null,
	grant_count: 0
};
const grant = {
	id: ID,
	cell_id: ID,
	level: 'viewer',
	actor_id: null,
	role: 'member',
	scope_id: null,
	granted_by: ID,
	created_at: AT
};
const field = { source_id: ID, name: 'cover', target_id: ID, created_at: AT };
const item = { parent_id: ID, position: 'a0', child_id: ID, created_at: AT };
const audit_event = {
	id: ID,
	seq: 1,
	event_type: 'cell_create',
	outcome: 'success',
	actor_id: ID,
	created_at: AT
};

const refused: Array<[name: string, schema: AnySchema, row: object, key: string, value: unknown]> =
	[
		['CellJson created_at', CellJson, cell, 'created_at', PG_AT],
		['CellJson updated_at', CellJson, cell, 'updated_at', PG_AT],
		['CellJson deleted_at', CellJson, cell, 'deleted_at', PG_AT],
		['CellJson moderation', CellJson, cell, 'moderation', 'archived'],
		['CellJson kind', CellJson, cell, 'kind', 'a'.repeat(CELL_KIND_LENGTH_MAX + 1)],
		['GrantJson created_at', GrantJson, grant, 'created_at', PG_AT],
		['GrantJson role', GrantJson, grant, 'role', 'Not A Role'],
		['FieldJson created_at', FieldJson, field, 'created_at', PG_AT],
		['FieldJson name', FieldJson, field, 'name', 'Cover-Image'],
		['ItemJson created_at', ItemJson, item, 'created_at', PG_AT],
		['CellAuditEventJson created_at', CellAuditEventJson, audit_event, 'created_at', PG_AT],
		['CellAuditEventJson seq', CellAuditEventJson, audit_event, 'seq', 1.5],
		['CellAuditEventJson event_type', CellAuditEventJson, audit_event, 'event_type', '1 event'],
		['CellAuditEventJson outcome', CellAuditEventJson, audit_event, 'outcome', 'partial']
	];

describe('cell wire outputs', () => {
	test('take the rows both spines write', () => {
		assert.ok(is(CellJson, cell));
		assert.ok(is(CellJson, { ...cell, kind: null, moderation: 'pending', deleted_at: AT }));
		assert.ok(is(CellJson, { ...cell, kind: 'a'.repeat(CELL_KIND_LENGTH_MAX) }));
		for (const moderation of ['pending', 'approved', 'rejected', null]) {
			assert.ok(is(CellJson, { ...cell, moderation }), String(moderation));
		}
		assert.ok(is(GrantJson, grant));
		assert.ok(is(GrantJson, { ...grant, role: null, actor_id: ID }));
		assert.ok(is(FieldJson, field));
		assert.ok(is(ItemJson, item));
		assert.ok(is(CellAuditEventJson, audit_event));
		assert.ok(is(CellAuditEventJson, { ...audit_event, outcome: 'failure', actor_id: null }));
	});

	for (const [name, schema, row, key, value] of refused) {
		test(`${name} refuses ${JSON.stringify(value)}`, () => {
			assert.ok(is(schema, row), 'the row itself passes');
			assert.ok(!is(schema, { ...row, [key]: value }));
		});
	}
});
