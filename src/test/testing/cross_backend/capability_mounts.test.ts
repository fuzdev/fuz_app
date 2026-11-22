/**
 * Tests for the capability mount suite's classification — every capability
 * either probed or listed unprobed with a reason — and the rows it plans from
 * a backend's declarations (`plan_capability_mount_rows`, the data
 * `describe_capability_mounts_cross_tests` registers), since running them
 * needs a backend.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import {
	in_process_capabilities,
	type BackendCapabilities
} from '#lib/testing/cross_backend/capabilities.ts';
import {
	CAPABILITY_MOUNTS_ABSENT,
	plan_capability_mount_rows,
	PROBED_CAPABILITIES,
	resolve_capability_mounts_target,
	UNPROBED_CAPABILITIES,
	type CapabilityMountRow
} from '#lib/testing/cross_backend/capability_mounts.ts';

const target = resolve_capability_mounts_target({ base_url: 'http://localhost:1' });

const plan = (flags: Partial<BackendCapabilities>): Array<CapabilityMountRow> =>
	plan_capability_mount_rows({ ...in_process_capabilities, ...flags }, target);

describe('capability mount classification', () => {
	test('every capability is probed or unprobed, never both', () => {
		const probed: ReadonlySet<string> = new Set(PROBED_CAPABILITIES);
		const unprobed = Object.keys(UNPROBED_CAPABILITIES);
		assert.deepStrictEqual(
			unprobed.filter((flag) => probed.has(flag)),
			[],
			'a flag both probed and unprobed'
		);
		assert.deepStrictEqual(
			[...PROBED_CAPABILITIES, ...unprobed].sort(),
			Object.keys(in_process_capabilities).sort(),
			'probe each new capability or list it in UNPROBED_CAPABILITIES with why'
		);
	});

	test('every unprobed capability states why', () => {
		for (const [flag, reason] of Object.entries(UNPROBED_CAPABILITIES)) {
			assert.ok(reason.trim().length > 0, flag);
		}
	});
});

describe('plan_capability_mount_rows', () => {
	test('one running probe per probed flag naming its declaration', () => {
		const rows = plan({ ws: true, ws_account_actions: false, cell_crud: false });
		const probes = rows.filter((r) => r.group === 'capability mounts');
		assert.strictEqual(probes.length, PROBED_CAPABILITIES.length);
		for (const flag of PROBED_CAPABILITIES) {
			const row = probes.find((r) => r.name.startsWith(`${flag} declared `));
			assert.ok(row, flag);
			assert.strictEqual(row.mode, 'run', flag);
		}
		assert.ok(probes.some((r) => r.name.startsWith('cell_crud declared false: ')));
		assert.ok(probes.some((r) => r.name.startsWith('ws declared true: ')));
	});

	test('each unprobed flag is a skip carrying its reason', () => {
		const rows = plan({}).filter((r) => r.group === 'capability mounts not probed');
		assert.deepStrictEqual(
			rows.map((r) => [r.name, r.mode]),
			Object.entries(UNPROBED_CAPABILITIES).map(([flag, reason]) => [`${flag}: ${reason}`, 'skip'])
		);
	});

	test('every control runs against an absent surface when ws is declared', () => {
		const controls = plan({ ws: true }).filter((r) => r.group === 'capability mount controls');
		assert.ok(controls.length > 0);
		for (const row of controls) {
			assert.strictEqual(row.mode, 'run', row.name);
			assert.include(row.name, CAPABILITY_MOUNTS_ABSENT);
		}
	});

	test('without ws, the socket control is a gated skip and the rest still run', () => {
		const controls = plan({ ws: false }).filter((r) => r.group === 'capability mount controls');
		const skipped = controls.filter((r) => r.mode === 'gated_skip' || r.mode === 'skip');
		assert.strictEqual(skipped.length, 1);
		assert.strictEqual(skipped[0]!.mode, 'gated_skip');
		assert.include(skipped[0]!.name, "keeper's session socket");
		assert.ok(controls.filter((r) => r.mode === 'run').length > 0);
	});

	test('without ws, an undeclared account-actions flag has nothing to probe', () => {
		const rows = plan({ ws: false, ws_account_actions: false });
		assert.ok(!rows.some((r) => r.name.startsWith('ws_account_actions declared ')));
		const skip = rows.find((r) => r.name.startsWith('ws_account_actions: no WebSocket endpoint'));
		assert.strictEqual(skip?.mode, 'gated_skip');
	});

	test('without ws, a declared account-actions flag fails at once', async () => {
		const row = plan({ ws: false, ws_account_actions: true }).find((r) =>
			r.name.startsWith('ws_account_actions declared true: ')
		);
		assert.ok(row);
		assert.strictEqual(row.mode, 'fail');
		const error = await row.body(() => Promise.reject(new Error('no backend'))).catch((e) => e);
		assert.match(String(error), /ws_account_actions is true, but capabilities\.ws is false/);
	});
});
