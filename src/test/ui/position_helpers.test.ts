/**
 * Tests for `generate_position_styles` — pure CSS position calculation.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {generate_position_styles, type Position, type Alignment} from '$lib/ui/position_helpers.js';

const COMMON_STYLES = {position: 'absolute', 'z-index': '10'};

describe('generate_position_styles', () => {
	// --- cardinal positions (all 12 combos) ---

	const CARDINAL_CASES: Array<{
		position: Position;
		align: Alignment;
		expected: Record<string, string>;
	}> = [
		// left
		{
			position: 'left',
			align: 'start',
			expected: {
				...COMMON_STYLES,
				right: '100%',
				left: 'auto',
				top: '0',
				bottom: 'auto',
				transform: '',
				'transform-origin': 'right',
			},
		},
		{
			position: 'left',
			align: 'center',
			expected: {
				...COMMON_STYLES,
				right: '100%',
				left: 'auto',
				top: '50%',
				bottom: 'auto',
				transform: 'translateY(-50%)',
				'transform-origin': 'right',
			},
		},
		{
			position: 'left',
			align: 'end',
			expected: {
				...COMMON_STYLES,
				right: '100%',
				left: 'auto',
				top: 'auto',
				bottom: '0',
				transform: '',
				'transform-origin': 'right',
			},
		},
		// right
		{
			position: 'right',
			align: 'start',
			expected: {
				...COMMON_STYLES,
				left: '100%',
				right: 'auto',
				top: '0',
				bottom: 'auto',
				transform: '',
				'transform-origin': 'left',
			},
		},
		{
			position: 'right',
			align: 'center',
			expected: {
				...COMMON_STYLES,
				left: '100%',
				right: 'auto',
				top: '50%',
				bottom: 'auto',
				transform: 'translateY(-50%)',
				'transform-origin': 'left',
			},
		},
		{
			position: 'right',
			align: 'end',
			expected: {
				...COMMON_STYLES,
				left: '100%',
				right: 'auto',
				top: 'auto',
				bottom: '0',
				transform: '',
				'transform-origin': 'left',
			},
		},
		// top
		{
			position: 'top',
			align: 'start',
			expected: {
				...COMMON_STYLES,
				bottom: '100%',
				top: 'auto',
				left: '0',
				right: 'auto',
				transform: '',
				'transform-origin': 'bottom',
			},
		},
		{
			position: 'top',
			align: 'center',
			expected: {
				...COMMON_STYLES,
				bottom: '100%',
				top: 'auto',
				left: '50%',
				right: 'auto',
				transform: 'translateX(-50%)',
				'transform-origin': 'bottom',
			},
		},
		{
			position: 'top',
			align: 'end',
			expected: {
				...COMMON_STYLES,
				bottom: '100%',
				top: 'auto',
				left: 'auto',
				right: '0',
				transform: '',
				'transform-origin': 'bottom',
			},
		},
		// bottom
		{
			position: 'bottom',
			align: 'start',
			expected: {
				...COMMON_STYLES,
				top: '100%',
				bottom: 'auto',
				left: '0',
				right: 'auto',
				transform: '',
				'transform-origin': 'top',
			},
		},
		{
			position: 'bottom',
			align: 'center',
			expected: {
				...COMMON_STYLES,
				top: '100%',
				bottom: 'auto',
				left: '50%',
				right: 'auto',
				transform: 'translateX(-50%)',
				'transform-origin': 'top',
			},
		},
		{
			position: 'bottom',
			align: 'end',
			expected: {
				...COMMON_STYLES,
				top: '100%',
				bottom: 'auto',
				left: 'auto',
				right: '0',
				transform: '',
				'transform-origin': 'top',
			},
		},
	];

	test.each(CARDINAL_CASES)('$position/$align', ({position, align, expected}) => {
		assert.deepStrictEqual(generate_position_styles(position, align), expected);
	});

	// --- center and overlay ---

	test('center', () => {
		assert.deepStrictEqual(generate_position_styles('center'), {
			...COMMON_STYLES,
			top: '50%',
			left: '50%',
			transform: 'translate(-50%, -50%)',
			'transform-origin': 'center',
		});
	});

	test('overlay', () => {
		assert.deepStrictEqual(generate_position_styles('overlay'), {
			...COMMON_STYLES,
			top: '0',
			left: '0',
			width: '100%',
			height: '100%',
			'transform-origin': 'center',
		});
	});

	test('center ignores alignment and offset', () => {
		const base = generate_position_styles('center');
		assert.deepStrictEqual(generate_position_styles('center', 'start', '10px'), base);
		assert.deepStrictEqual(generate_position_styles('center', 'end', '20px'), base);
	});

	test('overlay ignores alignment and offset', () => {
		const base = generate_position_styles('overlay');
		assert.deepStrictEqual(generate_position_styles('overlay', 'start', '10px'), base);
		assert.deepStrictEqual(generate_position_styles('overlay', 'end', '20px'), base);
	});

	// --- offsets ---

	test.each([
		{position: 'left' as Position, prop: 'right'},
		{position: 'right' as Position, prop: 'left'},
		{position: 'top' as Position, prop: 'bottom'},
		{position: 'bottom' as Position, prop: 'top'},
	])('$position offset applies calc to $prop', ({position, prop}) => {
		const styles = generate_position_styles(position, 'start', '10px');
		assert.strictEqual(styles[prop], 'calc(100% + 10px)');
	});

	test('offset accepts different CSS units', () => {
		assert.strictEqual(
			generate_position_styles('left', 'start', '5rem').right,
			'calc(100% + 5rem)',
		);
		assert.strictEqual(
			generate_position_styles('left', 'start', '-8px').right,
			'calc(100% + -8px)',
		);
	});

	test('offset "0px" is treated as non-zero (string comparison)', () => {
		// has_offset uses `offset !== '0'`, so '0px' triggers the calc path
		const styles = generate_position_styles('left', 'start', '0px');
		assert.strictEqual(styles.right, 'calc(100% + 0px)');
	});

	// --- defaults and error handling ---

	test('defaults to center/center/0', () => {
		assert.deepStrictEqual(generate_position_styles(), generate_position_styles('center'));
	});

	test('throws on invalid position', () => {
		// @ts-expect-error testing invalid position
		assert.throws(() => generate_position_styles('invalid'));
	});

	// --- exhaustive smoke test ---

	test('all position/alignment/offset combinations produce valid styles', () => {
		const positions: Array<Position> = ['left', 'right', 'top', 'bottom', 'center', 'overlay'];
		const alignments: Array<Alignment> = ['start', 'center', 'end'];

		for (const position of positions) {
			for (const align of alignments) {
				for (const offset of ['0', '10px']) {
					const styles = generate_position_styles(position, align, offset);
					assert.strictEqual(styles.position, 'absolute');
					assert.strictEqual(styles['z-index'], '10');
				}
			}
		}
	});
});
