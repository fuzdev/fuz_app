/**
 * Tests for the cell wire schemas — the length cap on the wire `kind`, on
 * `cell_create` and on the `cell_list` filter, and the verdicts and issues of
 * the spots with a form of their own: the grant principal's `variant`, the item
 * position's pipe, and `cell_list`'s omitted input; the grant principal's
 * `RoleName` and `cell_list`'s closed moderation filter; and that every cell
 * input is strict and `cell_list`'s paging bounds hold.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { is, parse } from '@fuzdev/fuz_schema/schema.ts';

import { FRACTIONAL_INDEX_LENGTH_MAX } from '@fuzdev/fuz_util/fractional_index.ts';

import {
	CELL_KIND_LENGTH_MAX,
	CellCreateInput,
	CellGetInput,
	CellListInput,
	all_cell_action_specs
} from '#lib/auth/cell_action_specs.ts';
import { CellGrantCreateInput } from '#lib/auth/cell_grant_action_specs.ts';
import { CellItemPosition } from '#lib/auth/cell_item_action_specs.ts';
import { NAME_LENGTH_MAX } from '#lib/auth/name_schema.ts';

const ID = '3f8a1c2e-1234-4abc-9def-0123456789ab';

const astral = '\u{1F600}';

describe('cell kind length cap', () => {
	test('CellCreateInput admits a kind at the cap and refuses one past it', () => {
		const at_cap = parse(CellCreateInput, { data: {}, kind: 'a'.repeat(CELL_KIND_LENGTH_MAX) });
		assert.ok(at_cap.ok);
		assert.strictEqual(at_cap.value.kind?.length, CELL_KIND_LENGTH_MAX);
		assert.ok(!is(CellCreateInput, { data: {}, kind: 'a'.repeat(CELL_KIND_LENGTH_MAX + 1) }));
		// typeless stays admitted
		assert.ok(is(CellCreateInput, { data: {}, kind: null }));
		assert.ok(is(CellCreateInput, { data: {} }));
	});

	test('CellCreateInput counts UTF-16 code units', () => {
		assert.ok(is(CellCreateInput, { data: {}, kind: astral.repeat(CELL_KIND_LENGTH_MAX / 2) }));
		assert.ok(
			!is(CellCreateInput, { data: {}, kind: astral.repeat(CELL_KIND_LENGTH_MAX / 2) + 'a' })
		);
	});

	test('CellListInput admits a kind filter at the cap and refuses one past it', () => {
		assert.ok(is(CellListInput, { kind: 'a'.repeat(CELL_KIND_LENGTH_MAX) }));
		assert.ok(!is(CellListInput, { kind: 'a'.repeat(CELL_KIND_LENGTH_MAX + 1) }));
		// the empty filter is admitted: it matches nothing
		assert.ok(is(CellListInput, { kind: '' }));
	});
});

describe('CellListInput moderation filter', () => {
	test('takes a CellModeration marker and refuses any other value', () => {
		for (const moderation of ['pending', 'approved', 'rejected']) {
			assert.ok(is(CellListInput, { moderation }), moderation);
		}
		for (const moderation of ['', 'bogus', 'Pending', null, 1]) {
			const result = parse(CellListInput, { moderation });
			assert.ok(!result.ok, String(moderation));
			assert.deepStrictEqual(
				result.issues.map((i) => i.path),
				[['moderation']]
			);
		}
	});
});

describe('CellGetInput', () => {
	// the Rust spine's grammar: the max UUID in any case, lowercased
	test('takes the max UUID in any case', () => {
		for (const id of [
			'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
			'ffffffff-FFFF-ffff-FFFF-ffffffffffff'
		]) {
			const result = parse(CellGetInput, { id });
			assert(result.ok, id);
			assert.strictEqual(result.value.id, 'ffffffff-ffff-ffff-ffff-ffffffffffff');
		}
	});
});

describe('CellGrantPrincipalInput', () => {
	const create = (principal: unknown) =>
		parse(CellGrantCreateInput, { cell_id: ID, level: 'viewer', principal });

	test('takes either arm', () => {
		assert.ok(create({ kind: 'actor', actor_id: ID }).ok);
		assert.ok(create({ kind: 'role', role: 'member' }).ok);
		assert.ok(create({ kind: 'role', role: 'member', scope_id: null }).ok);
		assert.ok(create({ kind: 'role', role: 'member', scope_id: ID }).ok);
	});

	test('an unknown or missing kind is one issue at the discriminator', () => {
		for (const principal of [{ kind: 'group' }, { actor_id: ID }]) {
			const result = create(principal);
			assert.ok(!result.ok);
			assert.strictEqual(result.issues.length, 1);
			assert.strictEqual(result.issues[0]!.kind, 'variant');
			assert.deepStrictEqual(result.issues[0]!.path, ['principal', 'kind']);
		}
	});

	test("an arm's fields are checked by that arm alone", () => {
		const empty_role = create({ kind: 'role', role: '' });
		assert.ok(!empty_role.ok);
		assert.deepStrictEqual(
			empty_role.issues.map((i) => [i.kind, i.path]),
			[['regex', ['principal', 'role']]]
		);
		const other_arm = create({ kind: 'actor', actor_id: ID, role: 'member' });
		assert.ok(!other_arm.ok);
		assert.deepStrictEqual(
			other_arm.issues.map((i) => [i.kind, i.path]),
			[['unknown_key', ['principal', 'role']]]
		);
		const role_extra = create({ kind: 'role', role: 'member', actor_id: ID });
		assert.ok(!role_extra.ok);
		assert.deepStrictEqual(
			role_extra.issues.map((i) => [i.kind, i.path]),
			[['unknown_key', ['principal', 'actor_id']]]
		);
	});

	test('a role is a RoleName: off the name grammar or past NAME_LENGTH_MAX is refused', () => {
		for (const role of [
			'Admin',
			'a_',
			'_a',
			'a__b',
			'a1',
			'GLOBAL',
			'a b',
			'a'.repeat(NAME_LENGTH_MAX + 1)
		]) {
			assert.ok(!create({ kind: 'role', role }).ok, role);
		}
		assert.ok(create({ kind: 'role', role: 'a'.repeat(NAME_LENGTH_MAX) }).ok);
		assert.ok(create({ kind: 'role', role: 'teaching_assistant' }).ok);
		// an unregistered name on the grammar passes the schema: the handler refuses it
		assert.ok(create({ kind: 'role', role: 'nobody' }).ok);
	});
});

describe('CellItemPosition', () => {
	test('takes the base62 alphabet up to the cap', () => {
		assert.ok(is(CellItemPosition, 'a0Z'));
		assert.ok(is(CellItemPosition, 'a'.repeat(FRACTIONAL_INDEX_LENGTH_MAX)));
	});

	test('a length failure is the one issue, ahead of the alphabet', () => {
		const empty = parse(CellItemPosition, '');
		assert.ok(!empty.ok);
		assert.deepStrictEqual(
			empty.issues.map((i) => i.kind),
			['min_length']
		);
		const over = parse(CellItemPosition, '-'.repeat(FRACTIONAL_INDEX_LENGTH_MAX + 1));
		assert.ok(!over.ok);
		assert.deepStrictEqual(
			over.issues.map((i) => i.kind),
			['max_length']
		);
		const off_alphabet = parse(CellItemPosition, 'a-b');
		assert.ok(!off_alphabet.ok);
		assert.deepStrictEqual(
			off_alphabet.issues.map((i) => i.kind),
			['regex']
		);
	});
});

describe('CellListInput omitted', () => {
	test('reads as a fresh empty object, and null is refused', () => {
		const a = parse(CellListInput, undefined);
		const b = parse(CellListInput, undefined);
		assert.ok(a.ok && b.ok);
		assert.deepStrictEqual(a.value, {});
		assert.notStrictEqual(a.value, b.value, 'each parse makes its own');
		assert.ok(!is(CellListInput, null));
	});
});

describe('cell inputs', () => {
	/** A valid input per method, every spec of `all_cell_action_specs` named. */
	const valid: Record<(typeof all_cell_action_specs)[number]['method'], Record<string, unknown>> = {
		cell_create: { data: {} },
		cell_get: { id: ID },
		cell_update: { cell_id: ID },
		cell_delete: { cell_id: ID },
		cell_list: { limit: 1, offset: 0 },
		cell_clone: { source_id: ID },
		cell_moderate: { cell_id: ID, moderation: 'approved' },
		cell_policy_set: { cell_id: ID, policy: null },
		cell_grant_create: { cell_id: ID, level: 'viewer', principal: { kind: 'actor', actor_id: ID } },
		cell_grant_revoke: { grant_id: ID },
		cell_grant_list: { cell_id: ID },
		cell_field_set: { source_id: ID, name: 'cover', target_id: ID },
		cell_field_delete: { source_id: ID, name: 'cover' },
		cell_field_list: { source_id: ID },
		cell_item_insert: { parent_id: ID, child_id: ID, position: 'a0' },
		cell_item_move: { parent_id: ID, position: 'a0', new_position: 'a1' },
		cell_item_delete: { parent_id: ID, position: 'a0' },
		cell_item_list: { parent_id: ID },
		cell_audit_list: { cell_id: ID }
	};

	for (const spec of all_cell_action_specs) {
		test(`${spec.method} takes a valid input and refuses an unknown key`, () => {
			const input = valid[spec.method];
			assert.ok(is(spec.input, input), 'the valid input passes');
			assert.ok(!is(spec.input, { ...input, zzz: 1 }));
		});
	}

	test('CellListInput holds its paging bounds', () => {
		assert.ok(is(CellListInput, { limit: 1, offset: 0 }));
		assert.ok(!is(CellListInput, { limit: 0 }));
		assert.ok(!is(CellListInput, { limit: 1.5 }));
		assert.ok(!is(CellListInput, { offset: -1 }));
	});
});
