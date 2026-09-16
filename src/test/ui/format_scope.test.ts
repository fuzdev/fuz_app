/**
 * Tests for `format_scope.ts` — `FormatScope`, `default_format_scope`, and
 * `resolve_scope_label`. The per-prop → context → raw-uuid fallback chain
 * inside each consuming component is exercised by the helper tests below
 * plus the `format_scope_context.set` spy in `admin_rpc_adapters.test.ts`.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import {
	default_format_scope,
	resolve_scope_label,
	type FormatScope
} from '$lib/ui/format_scope.ts';
import { truncate_uuid } from '$lib/ui/ui_format.ts';

describe('default_format_scope', () => {
	test('returns null for any input — caller falls back to raw uuid', () => {
		assert.isNull(default_format_scope({ scope_id: null, role: 'admin' }));
		assert.isNull(default_format_scope({ scope_id: 'abc', role: 'admin' }));
	});
});

describe('FormatScope shape', () => {
	test('callback can return a label string', () => {
		const fs: FormatScope = ({ scope_id, role }) =>
			scope_id === null ? null : `${role}@${scope_id}`;
		assert.strictEqual(fs({ scope_id: 'X', role: 'classroom_teacher' }), 'classroom_teacher@X');
	});

	test('callback can return null to opt out per-row', () => {
		const fs: FormatScope = ({ scope_id, role }) => {
			if (!role.startsWith('classroom_')) return null;
			return scope_id;
		};
		assert.isNull(fs({ scope_id: 'X', role: 'admin' }));
		assert.strictEqual(fs({ scope_id: 'X', role: 'classroom_teacher' }), 'X');
	});
});

describe('resolve_scope_label', () => {
	const uuid = '00000000-0000-0000-0000-0000000000aa';

	test('returns global_label for scope_id === null', () => {
		assert.strictEqual(
			resolve_scope_label(null, 'admin', default_format_scope, 'global'),
			'global'
		);
		assert.isNull(resolve_scope_label(null, 'admin', default_format_scope, null));
	});

	test('uses format_scope output when non-null', () => {
		const fs: FormatScope = ({ scope_id, role }) => `${role}/${scope_id}`;
		assert.strictEqual(resolve_scope_label(uuid, 'teacher', fs, 'global'), `teacher/${uuid}`);
	});

	test('falls back to truncate_uuid when format_scope returns null', () => {
		assert.strictEqual(
			resolve_scope_label(uuid, 'teacher', default_format_scope, 'global'),
			truncate_uuid(uuid)
		);
	});
});
