/**
 * No library module imports Zod at runtime but `zod_schemas.ts`, the Zod
 * forms of the primitives an app's Zod schemas embed: the dual-library layer
 * reads a consumer's Zod schema by its traits (`zod_has_trait`) and its own
 * methods, so an app with no Zod schema loads no Zod.
 *
 * No declaration a library module emits references Zod either, but `zod.ts`
 * and `zod_schemas.ts`: an app with no Zod installed typechecks against the
 * rest of the public types. Each module's declaration is emitted alone
 * (`ts.transpileDeclaration`), so a Zod type in an exported signature, written
 * out or by an `import('zod')` type, fails here. A module may import Zod types
 * for internal use (casts); only an exported shape reaching the declaration
 * counts. An export whose type is inferred (TS9010, a fuz_schema constant) is
 * left out of the emit, so exports that name Zod types carry explicit
 * annotations.
 *
 * That emit can't see through a call into `zod.ts` or `zod_schemas.ts`: an
 * export whose type is inferred from one is written `any` with an
 * isolated-declaration diagnostic, where a real build names Zod types. So a
 * module that imports Zod, `zod.ts` or `zod_schemas.ts` must emit with no such
 * diagnostic but the pinned `ISOLATED_DECLARATION_ALLOWLIST`, each a fuz_schema
 * constant.
 *
 * @module
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { assert, test } from 'vitest';

const LIB_DIR = fileURLToPath(new URL('../lib/', import.meta.url));

/** The one module allowed a runtime import of Zod. */
const ZOD_RUNTIME_MODULES: ReadonlySet<string> = new Set(['zod_schemas.ts']);

const list_sources = (dir: string): Array<string> =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return list_sources(path);
		return /\.(ts|svelte)$/.test(entry.name) ? [path] : [];
	});

// an `import` of `zod` that isn't `import type`, a side-effect import included
const ZOD_VALUE_IMPORT = /^\s*import\s+(?!type\s)(?:[^;]*?\sfrom\s+)?['"]zod(?:\/[^'"]*)?['"]/m;

test('only zod_schemas.ts imports Zod at runtime', () => {
	const importers = list_sources(LIB_DIR)
		.filter((path) => ZOD_VALUE_IMPORT.test(readFileSync(path, 'utf8')))
		.map((path) => relative(LIB_DIR, path));
	assert.deepStrictEqual(importers.sort(), [...ZOD_RUNTIME_MODULES]);
});

test('the pattern tells a value import from a type import', () => {
	assert.ok(ZOD_VALUE_IMPORT.test("import { z } from 'zod';"));
	assert.ok(ZOD_VALUE_IMPORT.test("import * as z from 'zod';"));
	assert.ok(ZOD_VALUE_IMPORT.test("\timport { z } from 'zod/v4';"));
	assert.ok(ZOD_VALUE_IMPORT.test("import 'zod';"));
	assert.isFalse(ZOD_VALUE_IMPORT.test("import type { z } from 'zod';"));
	assert.isFalse(ZOD_VALUE_IMPORT.test("import { x } from 'zodiac';"));
});

/** The modules whose declarations may name Zod types. */
const ZOD_DECLARATION_MODULES: ReadonlySet<string> = new Set(['zod.ts', 'zod_schemas.ts']);

const is_zod_specifier = (text: string): boolean => text === 'zod' || text.startsWith('zod/');

/** The Zod module specifiers a declaration file's text imports, exports from, or names in an `import()` type. */
const zod_specifiers = (declaration: string): Array<string> => {
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
		}
		if (specifier && ts.isStringLiteral(specifier) && is_zod_specifier(specifier.text)) {
			found.push(specifier.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(ts.createSourceFile('declaration.d.ts', declaration, ts.ScriptTarget.Latest, true));
	return found;
};

const transpile_declaration = (path: string, source: string): ts.TranspileOutput =>
	ts.transpileDeclaration(source, {
		fileName: path,
		reportDiagnostics: true,
		compilerOptions: {
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			allowImportingTsExtensions: true
		}
	});

const emit_declaration = (path: string): string =>
	transpile_declaration(path, readFileSync(path, 'utf8')).outputText;

test('only zod.ts and zod_schemas.ts emit a declaration that references Zod', () => {
	const leaking = list_sources(LIB_DIR)
		.filter((path) => path.endsWith('.ts'))
		.map((path) => relative(LIB_DIR, path))
		.filter((path) => !ZOD_DECLARATION_MODULES.has(path))
		.filter((path) => zod_specifiers(emit_declaration(join(LIB_DIR, path))).length > 0);
	assert.deepStrictEqual(leaking, []);
});

test('the declaration scan sees a Zod type however it is written', () => {
	assert.deepStrictEqual(zod_specifiers("import type { z } from 'zod';"), ['zod']);
	assert.deepStrictEqual(zod_specifiers("export type { ZodType } from 'zod/v4';"), ['zod/v4']);
	assert.deepStrictEqual(zod_specifiers("export declare const a: import('zod').ZodType;"), ['zod']);
	assert.deepStrictEqual(zod_specifiers("// import {z} from 'zod';\nexport {};"), []);
	assert.deepStrictEqual(zod_specifiers("import type { x } from 'zodiac';"), []);
});

test('a module that names a Zod type in an exported signature is caught', () => {
	const source = "import type { z } from 'zod';\nexport const f = (s: z.ZodType): void => {};";
	const hidden =
		"import type { z } from 'zod';\nexport const f = (s: unknown): void => { (s as z.ZodType); };";
	const emit = (text: string): string =>
		ts.transpileDeclaration(text, {
			fileName: 'm.ts',
			compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext }
		}).outputText;
	assert.deepStrictEqual(zod_specifiers(emit(source)), ['zod']);
	assert.deepStrictEqual(zod_specifiers(emit(hidden)), []);
});

/** The modules a Zod-touching module reaches Zod through, by resolved path under `lib/`. */
const ZOD_ENTRY_MODULES: ReadonlySet<string> = new Set(['zod.ts', 'zod_schemas.ts']);

/** Whether a module specifier, written in the file at `path`, names Zod or one of `ZOD_ENTRY_MODULES`. */
const reaches_zod = (path: string, specifier: string): boolean => {
	if (is_zod_specifier(specifier)) return true;
	if (!specifier.startsWith('.')) return false;
	return ZOD_ENTRY_MODULES.has(relative(LIB_DIR, resolve(dirname(path), specifier)));
};

/** Whether a source file imports or re-exports from Zod, `zod.ts`, or `zod_schemas.ts`. */
const imports_zod = (path: string, source: string): boolean => {
	let found = false;
	const visit = (node: ts.Node): void => {
		if (found) return;
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
		}
		if (specifier && ts.isStringLiteral(specifier) && reaches_zod(path, specifier.text)) {
			found = true;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true));
	return found;
};

/**
 * Exports whose type is inferred from fuz_schema, so the emit leaves them
 * out (TS9010), keyed by module path under `lib/`. The rest of a Zod-touching
 * module annotates what it exports.
 */
const ISOLATED_DECLARATION_ALLOWLIST: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	['http/auth_shape.ts', new Set(['AuthAxisState'])],
	['schema_issues.ts', new Set(['WireIssue'])]
]);

/** The name of the top-level declaration whose span holds `pos`, else `?`. */
const declaration_name_at = (file: ts.SourceFile, pos: number): string => {
	for (const statement of file.statements) {
		if (pos < statement.getStart(file) || pos >= statement.getEnd()) continue;
		if (ts.isVariableStatement(statement)) {
			for (const d of statement.declarationList.declarations) {
				if (pos >= d.getStart(file) && pos < d.getEnd()) return d.name.getText(file);
			}
		}
		const name = (statement as { name?: ts.Node }).name;
		if (name) return name.getText(file);
		if (ts.isExportAssignment(statement)) return 'default';
	}
	return '?';
};

/** The isolated-declaration (or other) diagnostics of a module's emit, as `module: name (code)` entries. */
const declaration_diagnostics = (module: string, source: string): Array<string> => {
	const { diagnostics } = transpile_declaration(join(LIB_DIR, module), source);
	const file = ts.createSourceFile(module, source, ts.ScriptTarget.Latest, true);
	return (diagnostics ?? []).map(
		(d) =>
			`${module}: ${d.start === undefined ? '?' : declaration_name_at(file, d.start)} (TS${d.code})`
	);
};

/** The diagnostics of a module's emit that the allowlist doesn't pin. */
const unpinned_declaration_diagnostics = (module: string, source: string): Array<string> => {
	const allowed = ISOLATED_DECLARATION_ALLOWLIST.get(module);
	return declaration_diagnostics(module, source).filter(
		(entry) => !allowed || ![...allowed].some((name) => entry.startsWith(`${module}: ${name} (`))
	);
};

test('a module reaching Zod emits no inferred export outside the pinned list', () => {
	const modules = list_sources(LIB_DIR)
		.filter((path) => path.endsWith('.ts'))
		.map((path) => relative(LIB_DIR, path))
		.filter((module) => !ZOD_DECLARATION_MODULES.has(module));
	const unpinned: Array<string> = [];
	const seen: Set<string> = new Set();
	for (const module of modules) {
		const source = readFileSync(join(LIB_DIR, module), 'utf8');
		if (!imports_zod(join(LIB_DIR, module), source)) continue;
		seen.add(module);
		unpinned.push(...unpinned_declaration_diagnostics(module, source));
	}
	assert.deepStrictEqual(
		unpinned,
		[],
		"an export inferred from Zod or the zod modules is emitted as `any`: annotate the export's type"
	);
	// a pinned entry that no longer emits a diagnostic is stale
	for (const [module, names] of ISOLATED_DECLARATION_ALLOWLIST) {
		assert.ok(seen.has(module), `${module} no longer reaches Zod; drop it from the allowlist`);
		const entries = declaration_diagnostics(module, readFileSync(join(LIB_DIR, module), 'utf8'));
		for (const name of names) {
			assert.ok(
				entries.some((entry) => entry.startsWith(`${module}: ${name} (`)),
				`${module}: ${name} emits no diagnostic; drop it from the allowlist`
			);
		}
	}
});

test('the isolated-declaration scan catches an export inferred from a zod module', () => {
	const inferred = "import { f } from './zod.ts';\nexport const g = (s: unknown) => f(s as never);";
	const annotated =
		"import { f } from './zod.ts';\nexport const g = (s: unknown): object => f(s as never);";
	assert.ok(imports_zod(join(LIB_DIR, 'm.ts'), inferred));
	assert.ok(imports_zod(join(LIB_DIR, 'sub/m.ts'), "export * from '../zod_schemas.ts';"));
	assert.isFalse(imports_zod(join(LIB_DIR, 'm.ts'), "import { f } from './other.ts';"));
	assert.deepStrictEqual(unpinned_declaration_diagnostics('m.ts', inferred), ['m.ts: g (TS9007)']);
	assert.deepStrictEqual(unpinned_declaration_diagnostics('m.ts', annotated), []);
});
