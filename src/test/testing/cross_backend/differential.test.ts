import { assert, describe, test } from 'vitest';

import type { ConformanceCase } from '#lib/testing/cross_backend/conformance_case.ts';
import {
	check_known_divergence_ledger,
	type KnownDivergence
} from '#lib/testing/cross_backend/differential.ts';

const case_on = (name: string, method: string): ConformanceCase => ({
	name,
	request: { method, as: 'keeper' },
	expect: { status: 400 }
});

const CASES: ReadonlyArray<ConformanceCase> = [
	case_on('scope refusal one', 'account_token_create'),
	case_on('scope refusal two', 'account_token_create'),
	case_on('a list read', 'admin_account_list')
];

const entry = (match: Pick<KnownDivergence, 'case_name' | 'method'>): KnownDivergence =>
	({
		...match,
		tracking_id: 'probe',
		reason: 'probe',
		what_differs: ['body.error.data.reason']
	}) as KnownDivergence;

describe('check_known_divergence_ledger', () => {
	test('a ledger naming only real cases and methods has no problems', () => {
		assert.deepEqual(
			check_known_divergence_ledger(CASES, [
				entry({ case_name: ['scope refusal one', 'scope refusal two'] }),
				entry({ method: 'admin_account_list' })
			]),
			[]
		);
	});

	test('a dead case name behind a live one is reported', () => {
		assert.deepEqual(
			check_known_divergence_ledger(CASES, [
				entry({ case_name: ['scope refusal one', 'ghost case'] })
			]),
			["'probe' names no such case: 'ghost case'"]
		);
	});

	test('a dead method behind a live one is reported', () => {
		assert.deepEqual(
			check_known_divergence_ledger(CASES, [
				entry({ method: ['admin_account_list', 'admin_acount_list'] })
			]),
			["'probe' names a method no case sends: 'admin_acount_list'"]
		);
	});

	test('an entry matching no case is reported once', () => {
		assert.deepEqual(check_known_divergence_ledger(CASES, [entry({ case_name: 'ghost case' })]), [
			"'probe' matches no case — fix its case name or method"
		]);
		assert.deepEqual(check_known_divergence_ledger(CASES, [entry({ method: 'no_such_method' })]), [
			"'probe' matches no case — fix its case name or method"
		]);
	});
});
