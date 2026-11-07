/**
 * Tests for `testing/schema_generators.ts` — branded-string synthesis.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';
import { Hono } from 'hono';
import { TrieRouter } from 'hono/router/trie-router';
import { parse } from '@fuzdev/fuz_schema/schema.ts';

import { generate_valid_body, resolve_valid_path } from '#lib/testing/schema_generators.ts';
import { ZodFactHashSchema } from '#lib/zod_schemas.ts';
import {
	account_session_revoke_action_spec,
	account_token_revoke_action_spec
} from '#lib/auth/account_action_specs.ts';
import { API_TOKEN_ID_REGEX } from '#lib/auth/api_token.ts';

describe('generate_valid_body — branded-string synthesis', () => {
	test('satisfies blake3 session_id pattern (account_session_revoke)', () => {
		const body = generate_valid_body(account_session_revoke_action_spec.input);
		assert.ok(body, 'expected a body');
		const parsed = parse(account_session_revoke_action_spec.input, body);
		assert.ok(parsed.ok, `body must round-trip: ${JSON.stringify(parsed)}`);
	});

	test('satisfies tok_ token_id pattern (account_token_revoke)', () => {
		const body = generate_valid_body(account_token_revoke_action_spec.input);
		assert.ok(body, 'expected a body');
		assert.match(String(body.token_id), API_TOKEN_ID_REGEX);
		const parsed = parse(account_token_revoke_action_spec.input, body);
		assert.ok(parsed.ok, `body must round-trip: ${JSON.stringify(parsed)}`);
	});

	test('satisfies a bare fixed-length hex pattern', () => {
		const schema = z.strictObject({ digest: z.string().regex(/^[0-9a-f]{64}$/) });
		const body = generate_valid_body(schema);
		assert.ok(body);
		const parsed = schema.safeParse(body);
		assert.ok(parsed.success, `body must round-trip: ${JSON.stringify(parsed)}`);
	});

	test('satisfies a bare prefix-lengthed slug pattern', () => {
		const schema = z.strictObject({ id: z.string().regex(/^foo_[A-Za-z0-9_-]{8}$/) });
		const body = generate_valid_body(schema);
		assert.ok(body);
		const parsed = schema.safeParse(body);
		assert.ok(parsed.success, `body must round-trip: ${JSON.stringify(parsed)}`);
	});

	test('satisfies a `prefix:`-tagged fixed-length hex pattern (the fact-hash shape)', () => {
		const schema = z.strictObject({ hash: ZodFactHashSchema });
		const body = generate_valid_body(schema);
		assert.ok(body);
		assert.strictEqual(body.hash, `blake3:${'0'.repeat(64)}`);
		const parsed = schema.safeParse(body);
		assert.ok(parsed.success, `body must round-trip: ${JSON.stringify(parsed)}`);
	});

	test('satisfies an uppercase-admitting tagged hex pattern', () => {
		const schema = z.strictObject({ digest: z.string().regex(/^sha256:[0-9a-fA-F]{64}$/) });
		const body = generate_valid_body(schema);
		assert.ok(body);
		const parsed = schema.safeParse(body);
		assert.ok(parsed.success, `body must round-trip: ${JSON.stringify(parsed)}`);
	});
});

describe('resolve_valid_path — params-schema-aware synthesis', () => {
	test('a `blake3:`-tagged hash param resolves to a value its schema accepts', () => {
		const params = z.strictObject({ hash: ZodFactHashSchema });
		const resolved = resolve_valid_path('/api/facts/:hash', params);
		const segment = decodeURIComponent(resolved.slice('/api/facts/'.length));
		assert.strictEqual(segment, `blake3:${'0'.repeat(64)}`);
		assert.ok(params.safeParse({ hash: segment }).success);
	});

	test('a patterned param is percent-encoded in the emitted path', () => {
		const params = z.strictObject({ hash: ZodFactHashSchema });
		const resolved = resolve_valid_path('/api/facts/:hash', params);
		// `:` must not reach the URL raw — it would read as a scheme separator
		// to some routers and as a literal to others.
		assert.ok(resolved.includes('%3A'), resolved);
	});

	test('a prefix-lengthed slug param resolves to a value its schema accepts', () => {
		const params = z.strictObject({ token_id: z.string().regex(/^tok_[A-Za-z0-9_-]{12}$/) });
		const resolved = resolve_valid_path('/api/tokens/:token_id', params);
		const segment = decodeURIComponent(resolved.slice('/api/tokens/'.length));
		assert.ok(params.safeParse({ token_id: segment }).success, segment);
	});

	test('a param whose only satisfying value contains a slash falls back', () => {
		// An absolute-path refinement would synthesize `/xxxxxxxxxx`, which
		// would silently add a path segment — the fallback keeps the route
		// shape intact even at the cost of a 400.
		const params = z.strictObject({ p: z.string().regex(/^\/[a-z]+$/) });
		assert.strictEqual(resolve_valid_path('/files/:p', params), '/files/test_p');
	});

	test('an unconstrained string param keeps the readable `test_<name>`', () => {
		// The param name in the URL is what makes a failure message legible,
		// so synthesis is the fallback, not the default.
		const params = z.strictObject({ slug: z.string() });
		assert.strictEqual(resolve_valid_path('/things/:slug', params), '/things/test_slug');
	});

	test('a uuid param keeps the nil-UUID fast path', () => {
		const params = z.strictObject({ id: z.uuid() });
		assert.strictEqual(
			resolve_valid_path('/things/:id', params),
			'/things/00000000-0000-0000-0000-000000000000'
		);
	});
});

describe('resolve_valid_path — the template read as Hono reads it', () => {
	const CASES: Array<[template: string, resolved: string]> = [
		['/things/:id', '/things/test_id'],
		['/a/:x/b/:y', '/a/test_x/b/test_y'],
		// a `:` inside a literal segment is no param
		['/v1/files:upload', '/v1/files:upload'],
		['/v1/:bucket/files:upload', '/v1/test_bucket/files:upload'],
		// a `{re}` goes with its param, a `/` inside it included
		['/f/:name{[a-z_]+}', '/f/test_name'],
		['/f/:path{[a-z_]+(?:/[a-z]+)?}', '/f/test_path'],
		// an optional param is filled
		['/a/:id?', '/a/test_id'],
		['/a/:id{[a-z_]+}?', '/a/test_id'],
		// no params, a wildcard, and the root are left as they are
		['/health', '/health'],
		['/api/*', '/api/*'],
		['/', '/'],
		['/a/', '/a/'],
		// a name is what Hono reads, its fallback percent-encoded
		['/a/:x-:y', '/a/test_x-%3Ay'],
		['/a/:p#q', '/a/test_p%23q']
	];

	for (const [template, resolved] of CASES) {
		test(template, () => {
			assert.strictEqual(resolve_valid_path(template), resolved);
		});
	}

	test('a param schema fills each param by its own name', () => {
		const params = z.strictObject({ bucket: z.uuid(), name: z.string() });
		assert.strictEqual(
			resolve_valid_path('/v1/:bucket/files:upload/:name{.+}', params),
			'/v1/00000000-0000-0000-0000-000000000000/files:upload/test_name'
		);
	});

	test('Hono routes each filled path back to its own template', async () => {
		for (const template of [
			'/things/:id',
			'/a/:x/b/:y',
			'/v1/:bucket/files:upload',
			'/a/:id?',
			'/a/:x-:y'
		]) {
			const app = new Hono();
			app.get(template, (c) => c.text('hit'));
			const res = await app.request(resolve_valid_path(template));
			assert.strictEqual(await res.text(), 'hit', template);
		}
	});

	test('a fallback its {re} accepts is kept', async () => {
		const template = '/f/:slug{[a-z_]+}/x';
		assert.strictEqual(resolve_valid_path(template), '/f/test_slug/x');
		const app = new Hono();
		app.get(template, (c) => c.text(c.req.param('slug')));
		const res = await app.request(resolve_valid_path(template));
		assert.strictEqual(await res.text(), 'test_slug');
	});

	test('a fallback its {re} refuses throws, naming the route and the param', () => {
		assert.throws(
			() => resolve_valid_path('/:slug_with_git{.+\\.git}/info/refs'),
			/the param `slug_with_git` of `\/:slug_with_git\{\.\+\\\.git\}\/info\/refs` resolves to "test_slug_with_git".*`param_values`.*'METHOD \/:slug_with_git/
		);
		// a schema-generated value is held to it too
		assert.throws(
			() => resolve_valid_path('/f/:n{[0-9]+}', z.strictObject({ n: z.string() })),
			/the param `n` of `\/f\/:n\{\[0-9\]\+\}`/
		);
	});

	test('the {re} is anchored at both ends', () => {
		// unanchored, `[0-9]` would find a digit in `a1b`, and `a|test_x` would match a prefix
		assert.throws(() => resolve_valid_path('/f/:n{[0-9]}', undefined, { n: 'a1b' }));
		assert.throws(() => resolve_valid_path('/f/:n{a|test}', undefined, { n: 'test_x' }));
		assert.strictEqual(
			resolve_valid_path('/f/:n{a|test_x}', undefined, { n: 'test_x' }),
			'/f/test_x'
		);
	});

	test('the {re} is grouped before it is anchored, as RegExpRouter reads an alternation, the stricter reading', async () => {
		// `^a|b$` would take `ab` by its first branch; RegExpRouter refuses it
		const template = '/f/:n{a|b}';
		assert.throws(() => resolve_valid_path(template, undefined, { n: 'ab' }));
		const app = new Hono();
		app.get(template, (c) => c.text('hit'));
		assert.strictEqual((await app.request('/f/ab')).status, 404);
		// TrieRouter leaves the alternation ungrouped and takes it, so refusing is the stricter side
		const trie_app = new Hono({ router: new TrieRouter() });
		trie_app.get(template, (c) => c.text('hit'));
		assert.strictEqual(await (await trie_app.request('/f/ab')).text(), 'hit');
		assert.strictEqual(resolve_valid_path(template, undefined, { n: 'a' }), '/f/a');
	});

	test('a supplied value is used before the schema and the fallback', async () => {
		const template = '/:slug_with_git{.+\\.git}/info/refs';
		const resolved = resolve_valid_path(template, undefined, { slug_with_git: 'repo.git' });
		assert.strictEqual(resolved, '/repo.git/info/refs');
		// over a schema that accepts `test_<name>` too
		assert.strictEqual(
			resolve_valid_path('/things/:id', z.strictObject({ id: z.string() }), { id: 'given' }),
			'/things/given'
		);
		const app = new Hono();
		app.get(template, (c) => c.text(c.req.param('slug_with_git')));
		const res = await app.request(resolved);
		assert.strictEqual(await res.text(), 'repo.git');
	});

	test('a supplied value is tested decoded, as Hono reads it', async () => {
		const template = '/f/:n{[a-z ]+}';
		const resolved = resolve_valid_path(template, undefined, { n: 'a b' });
		assert.strictEqual(resolved, '/f/a%20b');
		const app = new Hono();
		app.get(template, (c) => c.text(c.req.param('n')));
		assert.strictEqual(await (await app.request(resolved)).text(), 'a b');
	});

	test('a supplied `%` stays encoded as `%25` when tested, as Hono keeps it', async () => {
		const template = '/f/:n{[^%]+}';
		assert.throws(() => resolve_valid_path(template, undefined, { n: 'a%b' }), /refuses/);
		const app = new Hono();
		app.get(template, (c) => c.text('hit'));
		assert.strictEqual((await app.request('/f/a%25b')).status, 404);
		// the pattern sees the `%25` itself, as Hono's router does
		const kept = '/f/:n{a%25b}';
		assert.strictEqual(resolve_valid_path(kept, undefined, { n: 'a%b' }), '/f/a%25b');
		const kept_app = new Hono();
		kept_app.get(kept, (c) => c.text(c.req.param('n')));
		assert.strictEqual(await (await kept_app.request('/f/a%25b')).text(), 'a%b');
	});

	test('a supplied value the URL normalizes away throws by name', () => {
		for (const n of ['', '.', '..']) {
			assert.throws(
				() => resolve_valid_path('/f/:n/x', undefined, { n }),
				new RegExp(
					`the param \`n\` of \`/f/:n/x\` is ${JSON.stringify(n).replaceAll('.', '\\.')}, which the URL normalizes away`
				)
			);
		}
	});

	test('a supplied lone surrogate throws naming the param', () => {
		assert.throws(
			() => resolve_valid_path('/f/:n', undefined, { n: '\ud800' }),
			/the param `n` of `\/f\/:n` holds a lone surrogate/
		);
	});

	test('a supplied value its {re} refuses throws', () => {
		assert.throws(
			() => resolve_valid_path('/f/:n{[0-9]+}', undefined, { n: 'abc' }),
			/the value supplied for it,/
		);
	});

	test('a supplied value naming no param throws', () => {
		assert.throws(
			() => resolve_valid_path('/f/:n', undefined, { m: '1' }),
			/names `m`, which is no param of `\/f\/:n`/
		);
	});

	test('a supplied value holding `/` or `#` stays percent-encoded, as the fallback is', async () => {
		const template = '/:slug_with_git{.+\\.git}/info/refs';
		const resolved = resolve_valid_path(template, undefined, { slug_with_git: 'org/re#po.git' });
		assert.strictEqual(resolved, '/org%2Fre%23po.git/info/refs');
		// the `#` of a literal segment's fallback is encoded the same way
		assert.strictEqual(resolve_valid_path('/a/:p#q'), '/a/test_p%23q');
		const app = new Hono();
		app.get(template, (c) => c.text(c.req.param('slug_with_git')));
		const res = await app.request(resolved);
		assert.strictEqual(await res.text(), 'org/re#po.git');
		// a `[^/]+` pattern matches the encoded `/`, as Hono reads it
		assert.strictEqual(resolve_valid_path('/f/:n{[^/]+}', undefined, { n: 'a/b' }), '/f/a%2Fb');
	});
});

describe('generate_valid_body — union synthesis', () => {
	test('picks the first variant of a plain union of objects', () => {
		// Mirrors the shape of a target/config field — a union of two object
		// variants where the first variant satisfies its own schema once its
		// required string fields are filled.
		const Remote = z.strictObject({
			local: z.literal(false).optional(),
			host: z.string().min(1),
			user: z.string().min(1)
		});
		const Local = z.strictObject({ local: z.literal(true) });
		const schema = z.strictObject({ target: z.union([Remote, Local]) });

		const body = generate_valid_body(schema);
		assert.ok(body, 'expected a body');
		const parsed = schema.safeParse(body);
		assert.ok(parsed.success, `body must round-trip: ${JSON.stringify(parsed)}`);
	});

	test('picks the first variant of a union of primitives', () => {
		const schema = z.strictObject({ val: z.union([z.string(), z.number()]) });
		const body = generate_valid_body(schema);
		assert.ok(body);
		const parsed = schema.safeParse(body);
		assert.ok(parsed.success, `body must round-trip: ${JSON.stringify(parsed)}`);
	});

	test('synthesizes a union nested inside another object field', () => {
		const Inner = z.strictObject({
			cfg: z.union([
				z.strictObject({ mode: z.literal('a').optional(), label: z.string().min(1) }),
				z.strictObject({ mode: z.literal('b').optional(), n: z.number() })
			])
		});
		const schema = z.strictObject({ wrapper: Inner });

		const body = generate_valid_body(schema);
		assert.ok(body);
		const parsed = schema.safeParse(body);
		assert.ok(parsed.success, `body must round-trip: ${JSON.stringify(parsed)}`);
	});

	test('union wrapped in .optional() at the field level still synthesizes when required', () => {
		// Optional unwrap happens before the union case is reached.
		const schema = z.strictObject({
			target: z.union([
				z.strictObject({ host: z.string().min(1) }),
				z.strictObject({ local: z.literal(true) })
			])
		});

		const body = generate_valid_body(schema);
		assert.ok(body);
		const parsed = schema.safeParse(body);
		assert.ok(parsed.success, `body must round-trip: ${JSON.stringify(parsed)}`);
	});

	test('synthesizes a discriminated union whose first variant has a required literal discriminator', () => {
		// Without `case 'literal':` in generate_valid_value, the required
		// `kind: z.literal('local')` field on the first variant falls through
		// to `'test_value'`, which fails the literal check and breaks parse.
		const schema = z.strictObject({
			target: z.discriminatedUnion('kind', [
				z.strictObject({ kind: z.literal('local'), value: z.string().min(1) }),
				z.strictObject({ kind: z.literal('remote'), host: z.string().min(1) })
			])
		});

		const body = generate_valid_body(schema);
		assert.ok(body);
		const parsed = schema.safeParse(body);
		assert.ok(parsed.success, `body must round-trip: ${JSON.stringify(parsed)}`);
	});

	test('synthesizes a bare z.literal() field', () => {
		const schema = z.strictObject({ mode: z.literal('strict') });
		const body = generate_valid_body(schema);
		assert.ok(body);
		const parsed = schema.safeParse(body);
		assert.ok(parsed.success, `body must round-trip: ${JSON.stringify(parsed)}`);
		assert.strictEqual((parsed.data as { mode: string }).mode, 'strict');
	});
});
