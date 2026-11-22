/**
 * The transcript differential's import census: no suite the registry marks
 * `transcript: 'http'` reaches, through its module's value imports, a way of
 * sending the recording can't see, each suite excluded for what it sends
 * reaches a sender of that kind, and one excluded for what its HTTP traffic
 * carries (`HTTP_ONLY_KINDS`) reaches none.
 *
 * The recording wraps the fixture transports and patches `fetch` and the
 * global `WebSocket` (`transcript_record.ts`), so its tripwire catches those
 * but nothing that never calls them: the `ws` library, a raw socket
 * (`node:net`), or the modules built on them. A suite reaching one of those
 * sends traffic its transcript leaves out, so it is
 * `{excluded: {kind, reason}}`, not `'http'`. Type-only imports load nothing
 * and are not followed. The walk fails closed: a bare package it doesn't
 * know, a relative import of anything but a `.ts` or `.json` module, or an
 * `import()` / `require()` of a computed specifier throws, so a new way in
 * is read before it is trusted.
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { assert, describe, test } from 'vitest';

import {
	get_spine_suite_transcript,
	SUITE_NAMES,
	type SpineSuiteTranscriptExclusionKind,
	type SuiteName
} from '#lib/testing/cross_backend/spine_suites.ts';

import { TRANSCRIPT_SUITES } from './transcript_differential.ts';

const LIB_DIR = fileURLToPath(new URL('../../lib/', import.meta.url));

/**
 * The exclusion kinds that name no sender: the suite sends only over HTTP,
 * through the fixture, and is left out for what its traffic carries.
 */
const HTTP_ONLY_KINDS = [
	'embedded_secrets'
] as const satisfies ReadonlyArray<SpineSuiteTranscriptExclusionKind>;

/** The kinds of send the recording can't see — every exclusion kind but `HTTP_ONLY_KINDS`. */
type SendKind = Exclude<SpineSuiteTranscriptExclusionKind, (typeof HTTP_ONLY_KINDS)[number]>;

const is_http_only_kind = (
	kind: SpineSuiteTranscriptExclusionKind
): kind is (typeof HTTP_ONLY_KINDS)[number] =>
	(HTTP_ONLY_KINDS as ReadonlyArray<string>).includes(kind);

/**
 * The `src/lib` modules that send off the fixture transports, or are built to
 * drive those that do, each with the kinds it sends.
 */
const BANNED_MODULES: Readonly<Record<string, ReadonlyArray<SendKind>>> = {
	'testing/transports/raw_http.ts': ['raw_socket'],
	'testing/transports/ws_raw_client.ts': ['websocket', 'raw_socket'],
	'testing/transports/ws_transport.ts': ['websocket'],
	'testing/transports/sse_transport.ts': ['sse'],
	'testing/cross_backend/ws_endpoint.ts': ['websocket'],
	'testing/cross_backend/credential_wire.ts': ['raw_socket'],
	'testing/middleware_gate_probes.ts': ['raw_socket'],
	'actions/socket.svelte.ts': ['websocket'],
	'ui/audit_log_state.svelte.ts': ['sse']
};

/** The packages that open a socket the patch can't see, `node:` stripped. */
const BANNED_PACKAGES: Readonly<Record<string, ReadonlyArray<SendKind>>> = {
	ws: ['websocket'],
	net: ['raw_socket'],
	tls: ['raw_socket'],
	http: ['raw_socket'],
	https: ['raw_socket'],
	http2: ['raw_socket'],
	dgram: ['raw_socket']
};

/**
 * The bare packages the suites reach today that open no socket, by exact
 * specifier or by a `/`-ending prefix. A new one fails the census until it is
 * read and listed here or in `BANNED_PACKAGES`.
 */
const ALLOWED_PACKAGES: ReadonlyArray<string> = [
	'@fuzdev/fuz_schema/',
	'@fuzdev/fuz_util/',
	'esm-env',
	'node:crypto',
	'node:fs',
	'node:path',
	'node:url',
	'pg',
	'vitest'
];

/** Whether an import or export clause names only types, so it loads nothing. */
const is_type_only = (node: ts.ImportDeclaration | ts.ExportDeclaration): boolean => {
	if (ts.isExportDeclaration(node)) {
		if (node.isTypeOnly) return true;
		const clause = node.exportClause;
		return (
			clause !== undefined &&
			ts.isNamedExports(clause) &&
			clause.elements.length > 0 &&
			clause.elements.every((e) => e.isTypeOnly)
		);
	}
	const clause = node.importClause;
	if (!clause) return false; // a side-effect import loads the module
	if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return true;
	if (clause.name) return false;
	const bindings = clause.namedBindings;
	return (
		bindings !== undefined &&
		ts.isNamedImports(bindings) &&
		bindings.elements.length > 0 &&
		bindings.elements.every((e) => e.isTypeOnly)
	);
};

/**
 * The module specifiers a source loads at runtime: value imports, re-exports,
 * `import x = require()`, `import()` and `require()`.
 *
 * @throws Error on an `import()` or `require()` of a computed specifier
 */
const value_specifiers = (source: string, file = 'm.ts'): Array<string> => {
	const found: Array<string> = [];
	const visit = (node: ts.Node): void => {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			if (!is_type_only(node)) found.push(node.moduleSpecifier.text);
		} else if (
			ts.isImportEqualsDeclaration(node) &&
			!node.isTypeOnly &&
			ts.isExternalModuleReference(node.moduleReference) &&
			ts.isStringLiteral(node.moduleReference.expression)
		) {
			found.push(node.moduleReference.expression.text);
		} else if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === 'require'))
		) {
			const [specifier] = node.arguments;
			if (!specifier || !ts.isStringLiteralLike(specifier)) {
				throw new Error(`census: ${file} loads a computed specifier: ${node.getText()}`);
			}
			found.push(specifier.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true));
	return found;
};

/** Each module's value specifiers, parsed once across the walks. */
const specifier_cache: Map<string, Array<string>> = new Map();

const read_specifiers = (file: string): Array<string> => {
	let specifiers = specifier_cache.get(file);
	if (!specifiers) {
		specifiers = value_specifiers(readFileSync(file, 'utf8'), file);
		specifier_cache.set(file, specifiers);
	}
	return specifiers;
};

/** A send the recording can't see that a module reaches, with its import chain. */
interface CensusHit {
	readonly chain: string;
	readonly kinds: ReadonlyArray<SendKind>;
}

/**
 * Every sender a module reaches through its value imports.
 *
 * @throws Error on a package not allowed or banned, a relative import of
 *   neither a `.ts` nor a `.json` module, or a computed specifier
 */
const find_unrecordable = (entry: string): Array<CensusHit> => {
	const parent: Map<string, string | null> = new Map([[entry, null]]);
	const chain = (file: string): string => {
		const names: Array<string> = [];
		for (let f: string | null | undefined = file; f; f = parent.get(f)) {
			names.unshift(relative(LIB_DIR, f));
		}
		return names.join(' → ');
	};
	const hits: Array<CensusHit> = [];
	const queue = [entry];
	for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
		const banned = BANNED_MODULES[relative(LIB_DIR, file)];
		if (banned !== undefined) hits.push({ chain: chain(file), kinds: banned });
		for (const specifier of read_specifiers(file)) {
			const target = specifier.startsWith('.')
				? resolve(dirname(file), specifier)
				: specifier.startsWith('#lib/')
					? resolve(LIB_DIR, specifier.slice('#lib/'.length))
					: null;
			if (target === null) {
				const kinds = BANNED_PACKAGES[specifier.replace(/^node:/, '')];
				if (kinds !== undefined) {
					hits.push({ chain: `${chain(file)} → ${specifier}`, kinds });
				} else if (
					!ALLOWED_PACKAGES.some((p) =>
						p.endsWith('/') ? specifier.startsWith(p) : specifier === p
					)
				) {
					throw new Error(
						`census: ${chain(file)} imports '${specifier}', a package the census doesn't know — ` +
							'read it, then list it in ALLOWED_PACKAGES or BANNED_PACKAGES'
					);
				}
				continue;
			}
			if (target.endsWith('.json')) continue; // data, loading nothing that sends
			if (!target.endsWith('.ts')) {
				throw new Error(`census: ${chain(file)} imports '${specifier}', neither .ts nor .json`);
			}
			if (parent.has(target)) continue;
			parent.set(target, file);
			queue.push(target);
		}
	}
	return hits;
};

const suite_module = (name: SuiteName): string =>
	resolve(LIB_DIR, 'testing/cross_backend', `${name}.ts`);

const format_hit = (name: string, hit: CensusHit): string =>
	`${name}: ${hit.chain} (${hit.kinds.join(', ')})`;

describe('the transcript import census', () => {
	test("no 'http' suite reaches a send the recording can't see", () => {
		const problems = TRANSCRIPT_SUITES.flatMap((name) =>
			find_unrecordable(suite_module(name)).map((hit) => format_hit(name, hit))
		);
		assert.deepEqual(
			problems,
			[],
			"a suite reaching one of these sends outside the transcript: exclude it with its kind and reason (SuiteEntry.transcript in spine_suites.ts) instead of 'http'"
		);
	});

	test('every excluded suite reaches what its kind says, and an HTTP-only one nothing', () => {
		const problems: Array<string> = [];
		for (const name of SUITE_NAMES) {
			const transcript = get_spine_suite_transcript(name);
			if (transcript === 'http') continue;
			const { kind } = transcript.excluded;
			const hits = find_unrecordable(suite_module(name));
			if (is_http_only_kind(kind)) {
				problems.push(...hits.map((hit) => `excluded as '${kind}', yet ${format_hit(name, hit)}`));
			} else if (!hits.some((hit) => hit.kinds.includes(kind))) {
				problems.push(
					`${name}: excluded as '${kind}', yet reaches no ${kind} sender` +
						(hits.length > 0 ? ` (reaches ${hits.map((h) => h.kinds.join('/')).join(', ')})` : '')
				);
			}
		}
		assert.deepEqual(problems, []);
	});

	test('a type-only import is not followed', () => {
		assert.deepEqual(
			value_specifiers(
				[
					"import type { A } from './a.ts';",
					"import { type B } from './b.ts';",
					"import { type C, D } from './c.ts';",
					"import './d.ts';",
					"export type { E } from './e.ts';",
					"export { F } from './f.ts';",
					"const g = await import('./g.ts');",
					"const h = require('./h.ts');"
				].join('\n')
			),
			['./c.ts', './d.ts', './f.ts', './g.ts', './h.ts']
		);
	});

	test('a computed specifier throws', () => {
		assert.throws(() => value_specifiers('const m = await import(name);'), /computed specifier/);
		assert.throws(() => value_specifiers('const m = require(`./${name}`);'), /computed specifier/);
	});
});
