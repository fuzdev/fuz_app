/**
 * Source census: every read a `src/lib` module (outside `testing/`) makes of
 * the raw request — a header through Hono or the Fetch `Headers`, Node's raw
 * header list, the query, the path params, the URL — is one the module is
 * listed for here, with its reason.
 *
 * The query string and the path params are read only by `http/request_target.ts`,
 * through its strict readers — never Hono's `c.req.query` or `c.req.param`
 * decoding, which leaves an escape that doesn't decode in the value as text.
 *
 * The gate headers and the credential headers — `Origin`, `Referer`, `Host`,
 * `Content-Type`, `Cookie`, `Authorization`, `X-Daemon-Token` — are read only
 * through `get_header_lines` (`http/header_lines.ts`), the lines the client
 * sent, and then by the strict readers of `http/request_headers.ts` and
 * `auth/credential_headers.ts`. A runtime's own view of a header — Hono's
 * `c.req.header`, a joined Fetch value, `@hono/node-server`'s upgrade
 * `Headers` rebuilt from Node's deduplicated view — decides nothing, so a
 * literal read of one of those names any other way fails here, in a listed
 * module too. Whole comment lines are left out, so a module may document
 * them.
 *
 * What it cannot see: a read through an alias (`const r = c.req`), a header
 * name computed at run time, a `Request` handed to a helper that reads it,
 * Hono's and the adapters' own reads (`serveStatic`, the Node upgrade
 * rebuild), and a consumer's modules — a consumer runs the same census over
 * its `src/lib` by copying this file and pointing `LIB_DIR` at it. It pins
 * which function a read goes through, not what the runtime hands that
 * function; the request header wire leg (`request_header_conformance_wire`)
 * holds that.
 *
 * @module
 */

import { test, assert, describe } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Absolute path to `src/lib`, resolved relative to this test. */
const LIB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../lib');

/** A kind of raw request read, by the spelling that makes it. */
const READS = {
	'c.req.header': /\.req\s*\.\s*header\s*\(/,
	'c.req.raw.headers': /\.req\s*\.\s*raw\s*\.\s*headers\b/,
	'request.headers': /\brequest\s*\.\s*headers\b/,
	rawHeaders: /\brawHeaders\b/,
	'c.req.query': /\.req\s*\.\s*(?:query|queries)\s*\(/,
	'c.req.param': /\.req\s*\.\s*param\s*\(/,
	'c.req.url': /\.req\s*\.\s*(?:raw\s*\.\s*)?url\b/
} as const satisfies Record<string, RegExp>;

type RequestRead = keyof typeof READS;

/** The reads each module may make, each with its reason. Every other module makes none. */
const ALLOWED: ReadonlyMap<string, { reads: ReadonlyArray<RequestRead>; reason: string }> = new Map(
	[
		[
			'http/header_lines.ts',
			{
				reads: ['c.req.raw.headers', 'rawHeaders'],
				reason:
					"`get_header_lines`: Node's raw header list where the adapter gives it, else the Fetch value"
			}
		],
		[
			'http/proxy.ts',
			{ reads: ['c.req.header'], reason: '`X-Forwarded-For`, read by the trusted-proxy walk' }
		],
		[
			'http/body_limit.ts',
			{
				reads: ['c.req.header'],
				reason: '`Content-Length` and `Transfer-Encoding`, the framing the body cap reads'
			}
		],
		[
			'http/dev_set_cookie_check.ts',
			{ reads: ['c.req.header'], reason: '`Upgrade`, DEV only, to skip an accepted upgrade' }
		],
		[
			'http/request_target.ts',
			{
				reads: ['c.req.url', 'c.req.param'],
				reason:
					'`read_request_query_pairs` and `read_request_route_params`: the query and the path params, decoded strictly'
			}
		]
	]
);

/** A literal read of a gate or credential header other than through `get_header_lines`. */
const NAMED_HEADER_READ =
	/(?:\.req\s*\.\s*header|\.req\s*\.\s*raw\s*\.\s*headers\s*\.\s*get|\brequest\s*\.\s*headers\s*\.\s*get)\s*\(\s*(['"`])(?:origin|referer|host|content-type|cookie|authorization|x-daemon-token)\1/i;

/** Blank whole comment lines (`//`, ` * `, `/**`), so docs may name what code may not. */
const strip_comment_lines = (source: string): string =>
	source.replace(/^\s*(?:\/\/|\/\*\*?|\*).*$/gm, '');

const lib_modules = (): Array<string> =>
	readdirSync(LIB_DIR, { recursive: true, encoding: 'utf8' })
		.filter((name) => /\.(?:ts|svelte)$/.test(name) && !name.startsWith('testing/'))
		.sort();

/** The kinds of read a module's source makes. */
const reads_of = (code: string): Array<RequestRead> =>
	(Object.keys(READS) as Array<RequestRead>).filter((read) => READS[read].test(code));

const census = lib_modules().map((module) => {
	const code = strip_comment_lines(readFileSync(join(LIB_DIR, module), 'utf8'));
	return { module, reads: reads_of(code), named_header_read: NAMED_HEADER_READ.test(code) };
});

describe('request reads census', () => {
	test('the census sees the reads it lists', () => {
		// a positive control: every listed module is found, and makes each read it is listed for
		for (const [module, { reads }] of ALLOWED) {
			const found = census.find((entry) => entry.module === module);
			assert.ok(found, `${module} is listed but not in src/lib`);
			for (const read of reads) {
				assert.include(found.reads, read, `${module} is listed for ${read} and no longer makes it`);
			}
		}
	});

	test('every raw request read is a listed one', () => {
		const failures = census.flatMap(({ module, reads }) => {
			const allowed = ALLOWED.get(module)?.reads ?? [];
			return reads.filter((read) => !allowed.includes(read)).map((read) => `${module}: ${read}`);
		});
		assert.deepStrictEqual(failures, [], 'unlisted raw request reads');
	});

	test('no gate or credential header is read but through get_header_lines', () => {
		const failures = census.filter((entry) => entry.named_header_read).map((entry) => entry.module);
		assert.deepStrictEqual(failures, [], 'a literal read of a gate or credential header');
	});

	test('the named-header rule sees each spelling it refuses', () => {
		for (const spelling of [
			"c.req.header('origin')",
			'c.req.header("Referer")',
			'c.req.header(`HOST`)',
			"c.req.raw.headers.get('content-type')",
			"request.headers.get('Cookie')",
			"c.req.header('authorization')",
			"c.req.header('X-Daemon-Token')"
		]) {
			assert.ok(NAMED_HEADER_READ.test(spelling), spelling);
		}
		assert.ok(!NAMED_HEADER_READ.test("c.req.header('x-forwarded-for')"));
		// a response's headers are not the request's
		assert.ok(!NAMED_HEADER_READ.test("response.headers.get('content-type')"));
	});
});
