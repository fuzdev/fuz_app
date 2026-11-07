/**
 * No library module references Zod: none imports it, at runtime or as a type,
 * and no declaration a module emits names it, so fuz_app neither loads nor
 * types against Zod. Every schema the library reads is `@fuzdev/fuz_schema`.
 *
 * Each module's source is scanned for a Zod module specifier — an import or
 * re-export of any form, an `import()` type, an `import x = require()` — and
 * each `.ts` module's declaration is emitted alone (`ts.transpileDeclaration`)
 * and scanned the same way, so a Zod type reaching an exported signature
 * fails here too. A Svelte component's scripts are scanned as source.
 *
 * @module
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { assert, test } from 'vitest';

const LIB_DIR = fileURLToPath(new URL('../lib/', import.meta.url));

const list_sources = (dir: string): Array<string> =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return list_sources(path);
		return /\.(ts|svelte)$/.test(entry.name) ? [path] : [];
	});

const is_zod_specifier = (text: string): boolean => text === 'zod' || text.startsWith('zod/');

/** The Zod module specifiers a TypeScript text imports, re-exports, or names in an `import()` type. */
const zod_specifiers = (text: string): Array<string> => {
	const found: Array<string> = [];
	const visit = (node: ts.Node): void => {
		let specifier: ts.Node | undefined;
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			specifier = node.moduleSpecifier;
		} else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
			specifier = node.argument.literal;
		} else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference)
		) {
			specifier = node.moduleReference.expression;
		} else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length > 0
		) {
			specifier = node.arguments[0];
		}
		if (specifier && ts.isStringLiteral(specifier) && is_zod_specifier(specifier.text)) {
			found.push(specifier.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(ts.createSourceFile('m.ts', text, ts.ScriptTarget.Latest, true));
	return found;
};

// the contents of a Svelte component's `<script>` blocks
const svelte_scripts = (source: string): string =>
	[...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');

const emit_declaration = (path: string, source: string): string =>
	ts.transpileDeclaration(source, {
		fileName: path,
		compilerOptions: {
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			allowImportingTsExtensions: true
		}
	}).outputText;

test('no library module imports Zod', () => {
	const importers = list_sources(LIB_DIR).filter((path) => {
		const source = readFileSync(path, 'utf8');
		return zod_specifiers(path.endsWith('.svelte') ? svelte_scripts(source) : source).length > 0;
	});
	assert.deepStrictEqual(
		importers.map((path) => relative(LIB_DIR, path)),
		[]
	);
});

test('no library module emits a declaration that references Zod', () => {
	const leaking = list_sources(LIB_DIR)
		.filter((path) => path.endsWith('.ts'))
		.filter(
			(path) => zod_specifiers(emit_declaration(path, readFileSync(path, 'utf8'))).length > 0
		);
	assert.deepStrictEqual(
		leaking.map((path) => relative(LIB_DIR, path)),
		[]
	);
});

test('the scan sees Zod however it is imported or named', () => {
	for (const text of [
		"import { z } from 'zod';",
		"import * as z from 'zod';",
		"import type { z } from 'zod';",
		"import 'zod';",
		"import { z } from 'zod/v4';",
		"export type { ZodType } from 'zod/v4';",
		"export declare const a: import('zod').ZodType;",
		"const z = await import('zod');",
		"import z = require('zod');"
	]) {
		assert.strictEqual(zod_specifiers(text).length, 1, text);
	}
	assert.deepStrictEqual(zod_specifiers("// import {z} from 'zod';\nexport {};"), []);
	assert.deepStrictEqual(zod_specifiers("import type { x } from 'zodiac';"), []);
	assert.deepStrictEqual(zod_specifiers("const s = 'zod';"), []);
});

test('the scan reads a Svelte component by its scripts', () => {
	const component = "<script lang=\"ts\">\n\timport { z } from 'zod';\n</script>\n<p>'zod'</p>";
	assert.strictEqual(zod_specifiers(svelte_scripts(component)).length, 1);
	assert.strictEqual(zod_specifiers(svelte_scripts("<p>import 'zod';</p>")).length, 0);
});

test('a Zod type in an exported signature reaches the emitted declaration', () => {
	const source = "import type { z } from 'zod';\nexport const f = (s: z.ZodType): void => {};";
	assert.deepStrictEqual(zod_specifiers(emit_declaration('m.ts', source)), ['zod']);
});
