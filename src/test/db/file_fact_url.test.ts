/**
 * `file:<shard>/<rest>` URL grammar tests.
 *
 * The pattern is the one guard between a `fact.external_url` — free text in
 * the row — and a filesystem path or an `X-Accel-Redirect`, and the serve path
 * streams what it resolves without re-hashing, so every shape it must refuse is
 * listed here. Each case is checked through all four exported forms
 * (`FILE_FACT_URL_PATTERN`, `is_file_fact_url`, `parse_file_fact_url`, the
 * `FileFactUrl` schema) so they cannot disagree.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import type { FactHash } from '@fuzdev/fuz_util/hash_schemas.ts';

import {
	FILE_FACT_URL_PATTERN,
	FileFactUrl,
	fact_disk_path,
	is_file_fact_url,
	mint_file_fact_url,
	parse_file_fact_url
} from '$lib/db/file_fact_url.ts';

const SHARD = 'af';
const REST = '1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262';
const VALID = `file:${SHARD}/${REST}`;

/** `REST` with its first `replacement.length` chars swapped, length kept. */
const rest_starting = (replacement: string): string => replacement + REST.slice(replacement.length);

const ACCEPTED: Array<[label: string, url: string, shard: string, rest: string]> = [
	['lowercase hex', VALID, SHARD, REST],
	['all digits', `file:00/${'0'.repeat(62)}`, '00', '0'.repeat(62)],
	['all letters', `file:ff/${'f'.repeat(62)}`, 'ff', 'f'.repeat(62)]
];

const REJECTED: Array<[label: string, url: string]> = [
	['parent traversal', 'file:../x'],
	['parent traversal to a system file', 'file:../../etc/passwd'],
	['absolute path', 'file:/abs/path'],
	['a `..` shard over a rest of the right length', `file:../${rest_starting('../')}`],
	['a rest spelled in `../` and hex at the right length', `file:../${'../'.repeat(20)}ab`],
	['a `.` in the rest', `file:${SHARD}/${rest_starting('.')}`],
	['a `/` in the rest', `file:${SHARD}/${rest_starting('a/')}`],
	['uppercase hex shard', `file:AF/${REST}`],
	['uppercase hex rest', `file:${SHARD}/${REST.toUpperCase()}`],
	['non-hex letter', `file:${SHARD}/${rest_starting('g')}`],
	['shard one char short', `file:a/${REST}`],
	['shard one char long', `file:afa/${REST}`],
	['rest one char short', `file:${SHARD}/${REST.slice(1)}`],
	['rest one char long', `file:${SHARD}/${REST}0`],
	['percent-encoded segment', `file:${SHARD}/${rest_starting('%2e%2e%2f')}`],
	['percent-encoded shard', `file:%2e/${REST}`],
	['embedded NUL', `file:${SHARD}/${rest_starting('\0')}`],
	['NUL after a valid URL', `${VALID}\0`],
	['backslash separator', `file:${SHARD}\\${REST}`],
	['backslash in the rest', `file:${SHARD}/${rest_starting('\\')}`],
	['empty rest', `file:${SHARD}/`],
	['empty shard', `file:/${REST}`],
	['no separator', `file:${SHARD}${REST}`],
	['trailing newline', `${VALID}\n`],
	['trailing carriage return', `${VALID}\r`],
	['leading newline', `\n${VALID}`],
	['leading space', ` ${VALID}`],
	['trailing space', `${VALID} `],
	['trailing slash', `${VALID}/`],
	['query string', `${VALID}?x=1`],
	['fragment', `${VALID}#x`],
	['authority form', `file://${SHARD}/${REST}`],
	['uppercase scheme', `FILE:${SHARD}/${REST}`],
	['no scheme', `${SHARD}/${REST}`],
	['a `blake3:` hash', `blake3:${SHARD}${REST}`],
	['https URL', 'https://example.test/facts/elsewhere.bin'],
	['https URL ending in a valid file URL', `https://example.test/${VALID}`],
	['scheme alone', 'file:'],
	['empty string', '']
];

describe('file fact url grammar', () => {
	test('accepts a well-formed URL and splits it into shard + rest', () => {
		for (const [label, url, shard, rest] of ACCEPTED) {
			assert(FILE_FACT_URL_PATTERN.test(url), `pattern accepts: ${label}`);
			assert(is_file_fact_url(url), `is_file_fact_url accepts: ${label}`);
			assert(FileFactUrl.safeParse(url).success, `FileFactUrl accepts: ${label}`);
			assert.deepEqual(parse_file_fact_url(url), { url, shard, rest }, label);
		}
	});

	test('rejects every other shape', () => {
		for (const [label, url] of REJECTED) {
			assert(!FILE_FACT_URL_PATTERN.test(url), `pattern rejects: ${label}`);
			assert(!is_file_fact_url(url), `is_file_fact_url rejects: ${label}`);
			assert(!FileFactUrl.safeParse(url).success, `FileFactUrl rejects: ${label}`);
			assert.equal(parse_file_fact_url(url), null, `parse_file_fact_url rejects: ${label}`);
		}
	});

	test('the pattern keeps no state between calls', () => {
		// A `g` or `y` flag would make `test` / `exec` alternate on one input.
		for (let i = 0; i < 3; i++) {
			assert(is_file_fact_url(VALID));
			assert(parse_file_fact_url(VALID) !== null);
		}
	});

	test('fact_disk_path and mint_file_fact_url round-trip through the parser', () => {
		const hash = `blake3:${SHARD}${REST}` as FactHash;
		const { shard, rest } = fact_disk_path(hash);
		assert.deepEqual({ shard, rest }, { shard: SHARD, rest: REST });
		const url = mint_file_fact_url(shard, rest);
		assert.equal(url, VALID);
		assert.deepEqual(parse_file_fact_url(url), { url, shard, rest });
	});
});
