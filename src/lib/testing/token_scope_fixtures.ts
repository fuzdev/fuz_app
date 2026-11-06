import './assert_dev_env.ts';

/**
 * Token-scope documents built to a size, for the tests of
 * `MAX_TOKEN_SCOPE_BYTES` — hono-free, so the cross-process suites import it.
 *
 * The cap counts UTF-8 bytes of a document's compact JSON on both spines.
 * `token_scope_methods_at_bytes` builds the method list whose `methods`
 * document is exactly a given size, the same list the Rust spine's tests
 * build, so a boundary pinned on one spine is the boundary on the other.
 *
 * @module
 */

import { to_bytes } from '@fuzdev/fuz_util/bytes.ts';

import { token_scope_methods } from '../auth/token_scope.ts';

/**
 * The UTF-8 byte length of the compact JSON of a `methods` scope over
 * `methods`, the unit `MAX_TOKEN_SCOPE_BYTES` counts. Method order changes the
 * document, not its length.
 *
 * @param methods - the scope's method names
 * @returns the byte length of `JSON.stringify(token_scope_methods(methods))`
 */
export const token_scope_methods_bytes = (methods: Array<string>): number =>
	to_bytes(JSON.stringify(token_scope_methods(methods))).length;

/**
 * Method names whose `methods` scope document is exactly `bytes` compact UTF-8
 * bytes: `account_token_list` (so a token over it can list its own account's
 * tokens), names `scope_cap_<i>_<filler>` while they fit, and an ASCII pad of
 * `x`s. A multibyte `filler` makes a document far under `bytes` in UTF-16 code
 * units. The names hold no `:` or `,`, so the printed `jsonb` text has exactly
 * one more byte per separator.
 *
 * @param bytes - the compact document's size; at least that of the first name alone
 * @param filler - the tail of every name but the first and the pad
 * @returns distinct method names, sorted, as the Rust spine stores them
 */
export const token_scope_methods_at_bytes = (bytes: number, filler: string): Array<string> => {
	const methods = ['account_token_list'];
	for (let i = 0; ; i++) {
		const next = `scope_cap_${String(i).padStart(3, '0')}_${filler}`;
		if (token_scope_methods_bytes([...methods, next, '']) > bytes) break;
		methods.push(next);
	}
	const pad = bytes - token_scope_methods_bytes([...methods, '']);
	if (pad < 0) throw new Error(`no methods document is ${bytes} bytes`);
	methods.push('x'.repeat(pad));
	return methods;
};
