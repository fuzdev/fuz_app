/**
 * Bundle symmetry tests for `all_actor_search_action_specs` ↔
 * `create_actor_search_actions`.
 *
 * Mirrors the symmetry check in ./actor_lookup_action_specs.test.ts.
 * One method today, but pinning the inverse so a future "added spec,
 * forgot handler" (or "added handler, forgot registry") fails fast.
 * Also pins the input's `'personal'` query, which keeps a search off the URL.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import {
	ActorSearchInput,
	all_actor_search_action_specs
} from '#lib/auth/actor_search_action_specs.ts';
import { create_actor_search_actions } from '#lib/auth/actor_search_actions.ts';
import { schema_has_sensitive_field, schema_sensitivity } from '#lib/schema_meta.ts';

const log = new Logger('test', { level: 'off' });

describe('all_actor_search_action_specs', () => {
	test('no method appears twice', () => {
		const methods = all_actor_search_action_specs.map((s) => s.method);
		assert.strictEqual(methods.length, new Set(methods).size, 'duplicate methods in registry');
	});

	test('every registry spec is mounted by create_actor_search_actions, and vice versa', () => {
		const handler_methods = create_actor_search_actions({ log }).map((a) => a.spec.method);
		const spec_methods = new Set(all_actor_search_action_specs.map((s) => s.method));
		for (const method of handler_methods) {
			assert.isTrue(spec_methods.has(method), `runtime mounts ${method} but registry omits it`);
		}
		const handler_set = new Set(handler_methods);
		for (const spec of all_actor_search_action_specs) {
			assert.isTrue(
				handler_set.has(spec.method),
				`registry has ${spec.method} but create_actor_search_actions doesn't mount it`
			);
		}
	});
});

describe('ActorSearchInput', () => {
	test('its query is personal, so a search goes as a POST, never in a GET URL', () => {
		assert.strictEqual(schema_sensitivity(ActorSearchInput.shape.query), 'personal');
		assert.isTrue(schema_has_sensitive_field(ActorSearchInput));
	});
});
