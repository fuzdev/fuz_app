/**
 * Fail-loud validation of the X-Accel facts nginx location.
 *
 * The `X-Accel-Redirect` serving path's confidentiality depends on the facts
 * nginx location being `internal;` — only the authz'd handler's redirect (an
 * internal subrequest) may reach it. A *public* facts location would serve any
 * fact's bytes to anyone who guesses the `<shard>/<rest>` path, bypassing every
 * cell-visibility check. `XAccelConfig` makes that assertion structural: a
 * consumer can only obtain the redirect prefix by building an `XAccelConfig`,
 * which runs this check and throws **loudly** on a missing or non-`internal;`
 * location — it cannot silently fall closed.
 *
 * This is a best-effort string check (brace-matched `location` blocks), the TS
 * twin of the Rust `fuz_fact_serving` `nginx.rs` — not a real nginx parser, but
 * it catches the security-critical omission. Distinct from
 * `validate_nginx_config` (`server/validate_nginx.ts`), which validates the
 * `/api` Authorization-strip + security headers and takes no facts-location
 * path.
 *
 * @module
 */

import { z } from 'zod';

/** Result of the facts-location check. */
export interface NginxFactsValidation {
	/** `true` when the facts location exists and is `internal;`. */
	ok: boolean;
	/** Fatal issues — a missing or non-`internal` facts location. */
	errors: Array<string>;
}

/** A brace-matched nginx `location` block: its path and raw body (incl. braces). */
interface NginxLocationBlock {
	path: string;
	content: string;
}

/** Strip every trailing `/` so `/_facts/` and `/_facts` compare equal. */
const trim_trailing_slashes = (value: string): string => value.replace(/\/+$/, '');

/** `true` if a location block body contains an `internal` directive. */
const is_internal = (content: string): boolean =>
	content.split(/[;\s]+/).some((token) => token === 'internal');

/**
 * Extract `{path, content}` for each `location … { … }` block, brace-matched so
 * nested blocks are kept whole. `path` is the last whitespace token before the
 * opening brace (the location path, after any modifier). Best-effort: a stray
 * `location` token in a comment can produce a spurious block, harmless for this
 * check.
 */
const find_location_blocks = (config: string): Array<NginxLocationBlock> => {
	const blocks: Array<NginxLocationBlock> = [];
	let search = 0;
	let kw: number;
	while ((kw = config.indexOf('location', search)) !== -1) {
		// Require a token boundary before `location` (start or whitespace) so
		// `relocation` etc. don't match.
		const boundary_ok = kw === 0 || /\s/.test(config[kw - 1]!);
		const after = kw + 'location'.length;
		const brace = config.indexOf('{', after);
		if (brace === -1) break;
		if (!boundary_ok) {
			search = after;
			continue;
		}
		const header = config.slice(after, brace).trim();
		const tokens = header.split(/\s+/).filter((token) => token.length > 0);
		const path = tokens.length > 0 ? tokens[tokens.length - 1]! : '';
		// Brace-match the body.
		let depth = 1;
		let i = brace + 1;
		while (i < config.length && depth > 0) {
			const ch = config[i];
			if (ch === '{') depth++;
			else if (ch === '}') depth--;
			i++;
		}
		blocks.push({ path, content: config.slice(brace, i) });
		search = i;
	}
	return blocks;
};

/**
 * Assert the nginx `location` serving the X-Accel facts prefix is `internal;`.
 *
 * `facts_location` is the path the X-Accel redirect prefix points at (e.g.
 * `/_facts/`). Returns a fatal error when no matching `location` block exists,
 * or when the matching block is not marked `internal;` — either is a public
 * facts location that bypasses cell visibility.
 *
 * @param config - the nginx config template string to check
 * @param facts_location - the facts location path the redirect prefix points at
 * @returns `{ok, errors}` — `ok` is `true` only when the location exists and is `internal;`
 */
export const validate_facts_internal_location = (
	config: string,
	facts_location: string
): NginxFactsValidation => {
	const errors: Array<string> = [];
	const normalized = trim_trailing_slashes(facts_location);
	const blocks = find_location_blocks(config);
	const matching = blocks.filter((block) => trim_trailing_slashes(block.path) === normalized);

	if (matching.length === 0) {
		errors.push(
			`No nginx \`location ${facts_location}\` block found — the X-Accel facts location must ` +
				`exist and be marked \`internal;\` so only the authz'd handler's redirect can reach it. ` +
				`A public facts location bypasses every cell-visibility check.`
		);
	} else if (!matching.some((block) => is_internal(block.content))) {
		errors.push(
			`nginx \`location ${facts_location}\` is NOT marked \`internal;\` — a public facts ` +
				`location serves any fact's bytes to anyone who guesses the path, bypassing every ` +
				`cell-visibility check. Add \`internal;\` to the block.`
		);
	}

	return { ok: errors.length === 0, errors };
};

/**
 * A validated X-Accel redirect configuration — the only handle that enables the
 * `X-Accel-Redirect` serving path in `server/serve_fact_route.ts`.
 *
 * The redirect prefix can be obtained **only** by passing the nginx config
 * through `validate_facts_internal_location` (via `create_x_accel_config`), so
 * X-Accel serving is impossible to enable without proving the facts location is
 * `internal;` at boot — a public facts location would bypass every
 * cell-visibility check. A Zod-branded type: the brand can't be forged without
 * an explicit cast, so the factory is the only ordinary construction path.
 */
export const XAccelConfig = z
	.strictObject({
		/** The validated redirect prefix the serving path prepends (e.g. `/_facts/`). */
		redirect_prefix: z.string()
	})
	.brand('XAccelConfig');
export type XAccelConfig = z.infer<typeof XAccelConfig>;

/**
 * A misconfigured X-Accel facts location — a fail-loud boot error thrown by
 * `create_x_accel_config`.
 */
export class XAccelConfigError extends Error {
	/** The validator errors that made the location unsafe. */
	readonly errors: Array<string>;
	constructor(errors: Array<string>) {
		super(`X-Accel facts location is not safely \`internal;\`: ${errors.join('; ')}`);
		this.name = 'XAccelConfigError';
		this.errors = errors;
	}
}

/**
 * Build a validated `XAccelConfig`, asserting the nginx `location` serving
 * `redirect_prefix` is `internal;`.
 *
 * The make-impossible-states gate: serving can only emit `X-Accel-Redirect`
 * into a location proven `internal;` at boot.
 *
 * @param redirect_prefix - the X-Accel redirect prefix (e.g. `/_facts/`)
 * @param nginx_config - the nginx config template string to validate against
 * @returns the validated `XAccelConfig` carrying `redirect_prefix`
 * @throws `XAccelConfigError` when `nginx_config` has no matching `location` for
 *   `redirect_prefix`, or the matching block is not marked `internal;` — either
 *   is a public facts location that bypasses every cell-visibility check.
 */
export const create_x_accel_config = (
	redirect_prefix: string,
	nginx_config: string
): XAccelConfig => {
	const validation = validate_facts_internal_location(nginx_config, redirect_prefix);
	if (!validation.ok) {
		throw new XAccelConfigError(validation.errors);
	}
	return XAccelConfig.parse({ redirect_prefix });
};
