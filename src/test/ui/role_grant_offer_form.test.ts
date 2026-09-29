/**
 * `RoleGrantOfferForm` takes its scope as a pair: `scope_kind` with
 * `scope_id`, or neither for a global offer. A lone `scope_id` is a type error
 * (a `-32602` refusal on the wire), pinned here at compile time — `gro
 * typecheck` fails if the `@ts-expect-error` lines stop erroring. The runtime
 * guard behind it (`submit_create`) is covered in
 * `role_grant_offers_state.svelte.test.ts`.
 *
 * @module
 */

import { test, assert } from 'vitest';
import type { ComponentProps } from 'svelte';

import type RoleGrantOfferForm from '$lib/ui/RoleGrantOfferForm.svelte';

type FormProps = ComponentProps<typeof RoleGrantOfferForm>;

const base = { to_account_id: 'acct', roles: ['teacher'] };

test('the scope prop is a pair', () => {
	const global: FormProps = { ...base };
	const global_nulls: FormProps = { ...base, scope_kind: null, scope_id: null };
	const scoped: FormProps = { ...base, scope_kind: 'classroom', scope_id: 'scope' };
	// @ts-expect-error — `scope_id` without `scope_kind`
	const lone_id: FormProps = { ...base, scope_id: 'scope' };
	// @ts-expect-error — `scope_kind` without `scope_id`
	const lone_kind: FormProps = { ...base, scope_kind: 'classroom' };
	assert.strictEqual([global, global_nulls, scoped, lone_id, lone_kind].length, 5);
});
