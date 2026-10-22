/**
 * Fail-loud validation of the X-Accel facts nginx location.
 *
 * The `X-Accel-Redirect` serving path's confidentiality depends on the facts
 * nginx location being `internal;` — only the authz'd handler's redirect (an
 * internal subrequest) may reach it. A *public* facts location would serve any
 * fact's bytes to anyone who guesses the `<shard>/<rest>` path, bypassing every
 * cell-visibility check. A location with its own `add_header` also stops the
 * server-level headers from applying, so the facts location must carry the fact
 * hardening headers itself (`fact_security_header_directives` in
 * `server/fact_security_headers.ts`).
 *
 * `XAccelConfig` makes these assertions structural: a consumer can only obtain
 * the redirect prefix by building an `XAccelConfig`, which runs
 * `validate_facts_internal_location` and throws **loudly** on any violation — it
 * cannot silently fall closed.
 *
 * ## Rules
 *
 * The config is tokenized as nginx reads it (`ngx_conf_read_token`): whitespace
 * is exactly space, tab, CR and LF; an unquoted word ends only at those or at
 * `;` / `{` (a `}` inside a word is part of it, and so is a `{` straight after
 * `$`); `#` starts a comment only where a token would start; quoted strings are
 * one word, with nginx's backslash escapes. It is then parsed into nested
 * blocks, and every `location` at any depth, in every `server` block, is
 * classified against the prefix (trailing slashes ignored). A location *serves
 * the prefix* when it is a prefix-type location (no modifier, or `^~`) whose
 * path is the prefix or below it. Each one must:
 *
 * - use `^~` — a plain prefix location is refused;
 * - be a direct child of a `server` block — one nested in another location is
 *   refused;
 * - carry, as top-level directives of its own body, an exact `internal;` and
 *   each `fact_security_header_directives` line (token-equal: whitespace and
 *   quoting are free, the words are not);
 * - set those headers with no other `add_header` — one naming a
 *   `FACT_SECURITY_HEADERS` header (ASCII case-insensitive) that is not
 *   token-equal to its required line is refused, since nginx sends both values
 *   and a client may read only the first (`sniff, nosniff`);
 * - hold only simple directives — any nested block (`location`, `if`,
 *   `limit_except`, …) is refused, and so is `include`, since included files
 *   are not followed.
 *
 * The first two rules are what keep regex locations out: nginx never evaluates
 * regex locations for a path whose longest prefix match is a `^~` location at
 * server level, and because every prefix location at or below the prefix must
 * be such a location, the longest match for any redirected path always is. (A
 * longer plain location below the prefix can't exist — the `^~` rule refuses
 * it.)
 *
 * The prefix may appear only in its own location lines and their bodies:
 * `internal;` admits every internal redirect and subrequest, so any other
 * directive with a word naming the prefix (trailing slash trimmed, so
 * `/_facts$uri` counts) is refused, in any block at any depth — a `rewrite`,
 * `try_files`, `error_page`, `index`, `add_before_body`, or a `set` / `map`
 * value that a redirect later reads. The only exemptions are each `location`'s
 * own modifier and path words and the bodies of the locations serving the
 * prefix.
 *
 * The prefix itself must be an absolute path ending in exactly one `/` — the
 * server appends `<shard>/<rest>` straight onto it, so `/_facts` would redirect
 * to `/_factsab/…`, outside the validated location. At least one location
 * serving the prefix must sit exactly at it (`/_facts` or `/_facts/`): one only
 * below it (`location ^~ /_facts/00/`) leaves every other redirect path to
 * whatever location matches next, and nginx compares location paths
 * byte-for-byte, so `/_facts//` sits below it too.
 *
 * Module directives that undo those guarantees are refused too:
 *
 * - `ssi` with any value but `off`, anywhere in the config. SSI `include
 *   virtual` is a subrequest, which `internal;` admits, so an SSI-processed
 *   response — a fact inheriting `ssi on` from `http` or `server`, or any page
 *   carrying user content — could include another fact's bytes.
 * - `more_set_headers` / `more_clear_headers` (headers-more) everywhere except
 *   inside a `location` that doesn't serve the prefix (or a block within one):
 *   they run after `add_header` and can strip the hardening headers, so they
 *   are refused in the facts location and at every level above it, including
 *   any block there (`if`, another `server`).
 *
 * Also refused: an `=` location on the prefix or below it (it can't serve the
 * nested paths the redirect emits); a regex location (`~` / `~*`) whose pattern
 * spells out the prefix (after unescaping `\/`, ASCII case-folded for `~*`) —
 * dead under the rules above, refused for the clearer message; a config with no
 * location at the prefix; and blocks nested more than 64 deep (a parse error, so
 * the walks can't exhaust the stack). `include` at server level is allowed, but
 * its file is not read — keep facts-related locations and the directives above
 * out of included files.
 *
 * The threat model is operator mistakes, not an adversarial config author: the
 * prefix check is textual, so a value assembled from pieces (`/_fac$1`) evades
 * it. Beyond the config text:
 *
 * - The validator checks URL paths only — another `root` or `alias` that maps
 *   onto the facts directory would serve its files publicly, so keep the facts
 *   directory outside every other location's root.
 * - nginx honours `X-Accel-Redirect` from any proxied upstream (`proxy_pass`,
 *   `fastcgi_pass`, `uwsgi_pass`, `scgi_pass`, `grpc_pass`), so every upstream in
 *   the server is trusted to point into the prefix; an untrusted one needs
 *   `proxy_ignore_headers X-Accel-Redirect;` (or the `fastcgi_` / `uwsgi_` /
 *   `scgi_` equivalent).
 * - Other module code can redirect internally too (njs `internalRedirect`, perl,
 *   echo), so run trusted modules and content only.
 *
 * The Rust twin is `fuz_fact_serving`'s `nginx.rs`, held to the same rules and
 * the same fixture corpus.
 *
 * @example
 * ```ts
 * const x_accel = create_x_accel_config(
 * 	'/_facts/',
 * 	`server {
 * 	location ^~ /_facts/ {
 * 		internal;
 * 		alias /srv/app/facts/;
 * 		${fact_security_header_directives().join('\n\t\t')}
 * 	}
 * }`
 * );
 * ```
 *
 * @module
 */

import { z } from 'zod';

import { FACT_SECURITY_HEADERS, fact_security_header_directives } from './fact_security_headers.ts';

/** Result of the facts-location check. */
export interface NginxFactsValidation {
	/** `true` when every rule passes. */
	ok: boolean;
	/** Fatal issues, each naming the offending location. */
	errors: Array<string>;
}

/**
 * Assert the nginx config serves the X-Accel facts prefix only from `internal;`
 * locations carrying the fact hardening headers. See the module docs for the
 * rules; every violation is collected, so one call reports them all.
 *
 * @param config - the nginx config string to check
 * @param facts_location - the facts location path the redirect prefix points at (e.g. `/_facts/`)
 * @returns `{ok, errors}` — `ok` is `true` only when every rule passes
 */
export const validate_facts_internal_location = (
	config: string,
	facts_location: string
): NginxFactsValidation => {
	let errors: Array<string>;
	try {
		errors = collect_errors(config, facts_location);
	} catch (err) {
		if (!(err instanceof NginxParseError)) throw err;
		errors = [
			`could not parse the nginx config (${err.message}) — the X-Accel facts location ` +
				`can't be verified \`internal;\`.`
		];
	}
	return { ok: errors.length === 0, errors };
};

const collect_errors = (config: string, facts_location: string): Array<string> => {
	const prefix = trim_trailing_slashes(facts_location);
	if (!facts_location.startsWith('/') || prefix === '') {
		return [
			`X-Accel redirect prefix \`${facts_location}\` must be an absolute path below \`/\` ` +
				`(e.g. \`/_facts/\`).`
		];
	}
	if (facts_location.length !== prefix.length + 1) {
		return [
			`X-Accel redirect prefix \`${facts_location}\` must end in exactly one \`/\` (e.g. ` +
				`\`/_facts/\`) — the server appends \`<shard>/<rest>\` straight onto it, so any other ` +
				`ending redirects outside the validated location.`
		];
	}
	const directives = parse_directives(tokenize(config));
	const locations: Array<NginxLocation> = [];
	collect_locations(directives, null, locations);

	const required = Object.entries(FACT_SECURITY_HEADERS).map(([name, value]) => [
		'add_header',
		name,
		value,
		'always'
	]);
	const rendered = fact_security_header_directives();

	const errors: Array<string> = [];
	let at_prefix = false;
	for (const location of locations) {
		const label = location_label(location);
		switch (location.modifier) {
			case 'named':
				break;
			case 'prefix':
			case 'prefix_no_regex': {
				if (!path_is_under(location.path, prefix)) break;
				// nginx compares location paths byte-for-byte, so `/_facts//` never matches
				// `/_facts/ab/…` — only `/_facts` and `/_facts/` sit at the prefix
				if (location.path === prefix || location.path === prefix + '/') at_prefix = true;
				if (location.modifier !== 'prefix_no_regex') {
					errors.push(
						`${label} must use \`^~\` (\`location ^~ ${location.path}\`) — on a plain prefix ` +
							`location nginx goes on to check regex locations, any of which can serve fact ` +
							`bytes publicly.`
					);
				}
				if (location.parent !== 'server') {
					errors.push(
						`${label} must be a direct child of a \`server\` block — inside another ` +
							`block, \`^~\` doesn't stop nginx checking regex locations.`
					);
				}
				if (!has_directive(location.body, ['internal'])) {
					errors.push(
						`${label} is NOT marked \`internal;\` — a public facts location serves any ` +
							`fact's bytes to anyone who guesses the path, bypassing every ` +
							`cell-visibility check. Add \`internal;\` as a directive of the block itself.`
					);
				}
				for (let i = 0; i < required.length; i++) {
					if (!has_directive(location.body, required[i]!)) {
						errors.push(
							`${label} lacks \`${rendered[i]}\` — a location's own \`add_header\` replaces the ` +
								`server-level headers, so without it fact bytes go out without that ` +
								`hardening header.`
						);
					}
				}
				for (const directive of location.body) {
					const name = directive.args[0] ?? '';
					const header = directive.args[1];
					if (directive.block === null && name === 'add_header' && header !== undefined) {
						const index = required.findIndex(
							(args) => to_ascii_lowercase(args[1]!) === to_ascii_lowercase(header)
						);
						if (index !== -1 && !args_equal(directive.args, required[index]!)) {
							errors.push(
								`${label} has another \`add_header ${header}\` (line ${directive.line}) — nginx ` +
									`sends every \`add_header\` for a header and a client may read only the ` +
									`first, so the facts location may set \`${required[index]![1]}\` only with ` +
									`\`${rendered[index]}\`.`
							);
						}
					}
					if (directive.block !== null) {
						errors.push(
							`${label} contains a nested \`${name}\` block (line ${directive.line}) — the facts ` +
								`location must hold only simple directives, since a nested block can ` +
								`serve or re-header the bytes.`
						);
					} else if (name === 'include') {
						errors.push(
							`${label} contains \`include\` (line ${directive.line}) — included files are not ` +
								`followed, so the facts location can't contain one.`
						);
					}
				}
				break;
			}
			case 'exact':
				if (path_is_under(location.path, prefix)) {
					errors.push(
						`${label} is an exact-match location on the facts prefix — it can't serve ` +
							`the nested \`<shard>/<rest>\` paths the redirect emits, and one below the ` +
							`prefix shadows the internal location. Use a \`^~\` location.`
					);
				}
				break;
			case 'regex':
			case 'regex_caseless': {
				const pattern = location.path.replaceAll('\\/', '/');
				const shadows =
					location.modifier === 'regex_caseless'
						? to_ascii_lowercase(pattern).includes(to_ascii_lowercase(prefix))
						: pattern.includes(prefix);
				if (shadows) {
					errors.push(
						`${label} is a regex location naming the facts prefix — remove it; the ` +
							`facts location must be a server-level \`^~\` location, which nginx ` +
							`serves without checking regex locations.`
					);
				}
				break;
			}
		}
	}
	collect_prefix_mention_errors(directives, prefix, errors);
	collect_module_errors(directives, prefix, true, errors);
	if (!at_prefix) {
		errors.unshift(
			`No nginx \`location ^~ ${facts_location}\` block found — the X-Accel facts ` +
				`location must exist exactly at the prefix (one only below it leaves the other ` +
				`redirect paths uncovered) and be marked \`internal;\` so only the authz'd ` +
				`handler's redirect can reach it. A public facts location bypasses every ` +
				`cell-visibility check.`
		);
	}
	return errors;
};

/**
 * A validated X-Accel redirect configuration — the only handle that enables the
 * `X-Accel-Redirect` serving path in `server/serve_fact_route.ts`.
 *
 * The redirect prefix can be obtained **only** by passing the nginx config
 * through `validate_facts_internal_location` (via `create_x_accel_config`), so
 * X-Accel serving is impossible to enable without proving at boot that the
 * facts location is `internal;` and carries the fact hardening headers — a
 * public facts location would bypass every cell-visibility check. A
 * Zod-branded type: the brand can't be forged without an explicit cast, so the
 * factory is the only ordinary construction path.
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
 * Build a validated `XAccelConfig`, asserting the nginx config serves
 * `redirect_prefix` only from safe locations (the module-level rules).
 *
 * The make-impossible-states gate: serving can only emit `X-Accel-Redirect`
 * into a location proven `internal;` and header-carrying at boot.
 *
 * @param redirect_prefix - the X-Accel redirect prefix, ending in `/` (e.g. `/_facts/`)
 * @param nginx_config - the nginx config string to validate against
 * @returns the validated `XAccelConfig` carrying `redirect_prefix`
 * @throws `XAccelConfigError` carrying every violation
 *   `validate_facts_internal_location` finds — a prefix not ending in `/`, a
 *   missing, public, header-less, re-headered, exact-match, or regex-shadowed
 *   facts location, or `ssi` / headers-more reaching it.
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

/** Strip every trailing `/` so `/_facts/` and `/_facts` compare equal. */
const trim_trailing_slashes = (value: string): string => value.replace(/\/+$/, '');

/** ASCII-only lowercasing, so both twins fold exactly the same characters. */
const to_ascii_lowercase = (value: string): string =>
	value.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** `true` when `path` is `prefix` or below it, trailing slashes ignored. */
const path_is_under = (path: string, prefix: string): boolean => {
	const trimmed = trim_trailing_slashes(path);
	return trimmed === prefix || (trimmed.startsWith(prefix) && trimmed[prefix.length] === '/');
};

/**
 * `true` when `body` has a top-level simple directive whose words are exactly
 * `args` (a block directive with those words doesn't count).
 */
const has_directive = (body: Array<NginxDirective>, args: Array<string>): boolean =>
	body.some((d) => d.block === null && args_equal(d.args, args));

/** `true` when `a` and `b` hold the same words in the same order. */
const args_equal = (a: Array<string>, b: Array<string>): boolean =>
	a.length === b.length && a.every((word, i) => word === b[i]);

type LocationModifier =
	'prefix' | 'prefix_no_regex' | 'exact' | 'regex' | 'regex_caseless' | 'named';

const MODIFIER_TEXT: Record<LocationModifier, string> = {
	prefix: '',
	named: '',
	prefix_no_regex: '^~ ',
	exact: '= ',
	regex: '~ ',
	regex_caseless: '~* '
};

/** The modifiers nginx accepts as a separate word (`= /x`). */
const SEPARATE_MODIFIERS: ReadonlyMap<string, LocationModifier> = new Map([
	['=', 'exact'],
	['^~', 'prefix_no_regex'],
	['~', 'regex'],
	['~*', 'regex_caseless']
]);

/**
 * The modifiers nginx accepts glued to the path (`=/x`), longest first so `^~`
 * / `~*` aren't read as `~`.
 */
const GLUED_MODIFIERS: Array<[string, LocationModifier]> = [
	['^~', 'prefix_no_regex'],
	['~*', 'regex_caseless'],
	['~', 'regex'],
	['=', 'exact']
];

interface NginxLocation {
	modifier: LocationModifier;
	path: string;
	line: number;
	/** The first word of the enclosing block directive (`server`, `location`, …), `null` at the top level. */
	parent: string | null;
	body: Array<NginxDirective>;
}

const location_label = (location: NginxLocation): string =>
	`\`location ${MODIFIER_TEXT[location.modifier]}${location.path}\` (line ${location.line})`;

/**
 * Classify a `location`'s arguments (after the keyword) — the separate (`= /x`)
 * and glued (`=/x`) modifier forms nginx accepts.
 */
const parse_location_args = (
	args: Array<string>
): { modifier: LocationModifier; path: string } | null => {
	if (args.length === 2) {
		const modifier = SEPARATE_MODIFIERS.get(args[0]!);
		return modifier === undefined ? null : { modifier, path: args[1]! };
	}
	if (args.length === 1) {
		const glued = args[0]!;
		if (glued.startsWith('@')) return { modifier: 'named', path: glued };
		for (const [text, modifier] of GLUED_MODIFIERS) {
			if (glued.startsWith(text)) return { modifier, path: glued.slice(text.length) };
		}
		return { modifier: 'prefix', path: glued };
	}
	return null;
};

/**
 * Refuse every directive, in any block at any depth, with a word containing the
 * prefix (trailing slash trimmed, so `/_facts$uri` counts) — the prefix may
 * appear only in its own location lines and their bodies. Exempt: each
 * `location` directive's own modifier and path words, and the bodies of the
 * locations serving the prefix (held to simple directives elsewhere). A textual
 * heuristic against operator mistakes: a value assembled from pieces
 * (`/_fac$1`) is not caught.
 */
const collect_prefix_mention_errors = (
	directives: Array<NginxDirective>,
	prefix: string,
	errors: Array<string>
): void => {
	for (const directive of directives) {
		const name = directive.args[0] ?? '';
		if (name === 'location') {
			const parsed = parse_location_args(directive.args.slice(1));
			const serves_prefix =
				parsed !== null &&
				(parsed.modifier === 'prefix' || parsed.modifier === 'prefix_no_regex') &&
				path_is_under(parsed.path, prefix);
			if (directive.block !== null && !serves_prefix) {
				collect_prefix_mention_errors(directive.block, prefix, errors);
			}
			continue;
		}
		if (directive.args.some((word) => word.includes(prefix))) {
			errors.push(
				`\`${name}\` (line ${directive.line}) names the facts prefix — the prefix may appear only in its ` +
					`own location lines and their bodies; anything else naming it (a redirect, a ` +
					`subrequest, a variable that becomes one) can serve fact bytes publicly.`
			);
		}
		if (directive.block !== null) collect_prefix_mention_errors(directive.block, prefix, errors);
	}
};

/**
 * The headers-more module's response-header directives, which run after
 * `add_header` and so can strip or rewrite the fact hardening headers.
 */
const HEADERS_MORE_DIRECTIVES: ReadonlySet<string> = new Set([
	'more_set_headers',
	'more_clear_headers'
]);

/**
 * Refuse the module directives that undo the facts location's guarantees:
 *
 * - `ssi` with any value but `off`, in any block at any depth. SSI `include
 *   virtual` is a subrequest, which `internal;` admits, so an SSI-processed
 *   response — a fact served from the facts location (inheriting `ssi on` from
 *   `http` or `server`), or any page carrying user content — could include
 *   another fact's bytes by its path. A sibling location's `ssi on` is as
 *   dangerous as an inherited one, so the rule is config-wide.
 * - a headers-more directive anywhere except inside a `location` that doesn't
 *   serve the prefix (or a block within one): in the facts location's body, or
 *   at any level above it (`http`, `server`, top level, and any block there such
 *   as `if` or another `server`).
 *
 * `reaches_facts` is `true` while the walk is in a scope the facts location
 * inherits from or is.
 */
const collect_module_errors = (
	directives: Array<NginxDirective>,
	prefix: string,
	reaches_facts: boolean,
	errors: Array<string>
): void => {
	for (const directive of directives) {
		const name = directive.args[0] ?? '';
		if (directive.block === null) {
			if (
				name === 'ssi' &&
				!(directive.args.length === 2 && to_ascii_lowercase(directive.args[1]!) === 'off')
			) {
				errors.push(
					`\`ssi\` (line ${directive.line}) is not \`off\` — SSI \`include virtual\` subrequests ` +
						`reach the \`internal;\` facts location, so an SSI-processed response could ` +
						`include any fact's bytes by its path. Remove it or set \`ssi off;\`.`
				);
			} else if (reaches_facts && HEADERS_MORE_DIRECTIVES.has(name)) {
				errors.push(
					`\`${name}\` (line ${directive.line}) applies to the facts location — a ` +
						`headers-more directive in or above it can strip or rewrite the fact hardening ` +
						`headers after \`add_header\` sets them. Move it into the locations that need it.`
				);
			}
			continue;
		}
		let reaches = reaches_facts;
		if (name === 'location') {
			const parsed = parse_location_args(directive.args.slice(1));
			reaches =
				parsed !== null &&
				(parsed.modifier === 'prefix' || parsed.modifier === 'prefix_no_regex') &&
				path_is_under(parsed.path, prefix);
		}
		collect_module_errors(directive.block, prefix, reaches, errors);
	}
};

/**
 * Gather every `location` block at any depth, in document order, each with the
 * name of the block directly enclosing it.
 */
const collect_locations = (
	directives: Array<NginxDirective>,
	parent: string | null,
	out: Array<NginxLocation>
): void => {
	for (const directive of directives) {
		if (directive.block === null) continue;
		const name = directive.args[0] ?? '';
		if (name === 'location') {
			const args = directive.args.slice(1);
			const parsed = parse_location_args(args);
			if (parsed === null) {
				throw new NginxParseError(
					`unrecognised \`location ${args.join(' ')}\` (line ${directive.line})`
				);
			}
			out.push({ ...parsed, line: directive.line, parent, body: directive.block });
		}
		collect_locations(directive.block, name, out);
	}
};

/** A config the tokenizer or parser can't read — reported as a validation error. */
class NginxParseError extends Error {}

type NginxToken =
	{ kind: 'word'; text: string; line: number } | { kind: ';' | '{' | '}'; line: number };

/** nginx's config whitespace — exactly these four, nothing Unicode. */
const is_nginx_space = (ch: string): boolean =>
	ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';

/**
 * Apply nginx's word unescaping: `\"` `\'` `\\` drop the backslash, `\t` `\r`
 * `\n` become the control character, any other backslash stays.
 */
const unescape_word = (raw: string): string => {
	let out = '';
	for (let i = 0; i < raw.length; i++) {
		const c = raw[i]!;
		if (c === '\\') {
			const next = raw[i + 1];
			const replacement =
				next === '"' || next === "'" || next === '\\'
					? next
					: next === 't'
						? '\t'
						: next === 'r'
							? '\r'
							: next === 'n'
								? '\n'
								: undefined;
			if (replacement !== undefined) {
				out += replacement;
				i++;
				continue;
			}
		}
		out += c;
	}
	return out;
};

/**
 * Tokenize as nginx's `ngx_conf_read_token` reads a config — the same state
 * machine (`last_space`, `need_space`, `quoted`, `variable`, the quote and
 * comment flags), producing words and the `;` `{` `}` punctuation. Iterates
 * code points, as the Rust twin iterates `char`s.
 */
const tokenize = (config: string): Array<NginxToken> => {
	const tokens: Array<NginxToken> = [];
	let line = 1;
	let start_line = 1;
	let word = '';
	let last_space = true;
	let need_space = false;
	let quoted = false;
	let s_quoted = false;
	let d_quoted = false;
	let sharp_comment = false;
	let variable = false;
	for (const ch of config) {
		if (ch === '\n') {
			line++;
			sharp_comment = false;
		}
		if (sharp_comment) continue;
		if (quoted) {
			quoted = false;
			word += ch;
			continue;
		}
		if (need_space) {
			if (is_nginx_space(ch)) {
				last_space = true;
				need_space = false;
				continue;
			}
			if (ch === ';' || ch === '{') {
				need_space = false;
				last_space = true;
				tokens.push({ kind: ch, line });
				continue;
			}
			if (ch === ')') {
				last_space = true;
				need_space = false;
			} else {
				throw new NginxParseError(`unexpected \`${ch}\` after a quoted string, line ${line}`);
			}
		}
		if (last_space) {
			start_line = line;
			if (is_nginx_space(ch)) continue;
			if (ch === ';' || ch === '{' || ch === '}') {
				tokens.push({ kind: ch, line });
			} else if (ch === '#') {
				sharp_comment = true;
			} else if (ch === '"') {
				d_quoted = true;
				last_space = false;
			} else if (ch === "'") {
				s_quoted = true;
				last_space = false;
			} else {
				if (ch === '\\') {
					quoted = true;
				} else if (ch === '$') {
					variable = true;
				}
				last_space = false;
				word += ch;
			}
			continue;
		}
		if (ch === '{' && variable) {
			word += ch;
			continue;
		}
		variable = false;
		if (ch === '\\') {
			quoted = true;
			word += ch;
			continue;
		}
		if (ch === '$') {
			variable = true;
			word += ch;
			continue;
		}
		let found = false;
		if (d_quoted) {
			if (ch === '"') {
				d_quoted = false;
				need_space = true;
				found = true;
			}
		} else if (s_quoted) {
			if (ch === "'") {
				s_quoted = false;
				need_space = true;
				found = true;
			}
		} else if (is_nginx_space(ch) || ch === ';' || ch === '{') {
			last_space = true;
			found = true;
		}
		if (!found) {
			word += ch;
			continue;
		}
		tokens.push({ kind: 'word', text: unescape_word(word), line: start_line });
		word = '';
		if (ch === ';' || ch === '{') tokens.push({ kind: ch, line });
	}
	if (!last_space) {
		throw new NginxParseError(`unexpected end of file inside a word, line ${line}`);
	}
	return tokens;
};

/**
 * One parsed directive: its words, the line it starts on, and its block body
 * when it opens one (`server { … }`, `location … { … }`), else `null`.
 */
interface NginxDirective {
	args: Array<string>;
	line: number;
	block: Array<NginxDirective> | null;
}

/**
 * The deepest block nesting the parser accepts — far beyond any real config, and
 * low enough that the recursive walks can't exhaust the stack.
 */
const MAX_NESTING_DEPTH = 64;

const parse_directives = (tokens: Array<NginxToken>): Array<NginxDirective> => {
	const cursor = { pos: 0 };
	return parse_block(tokens, cursor, null, 0);
};

/**
 * Parse one block's directives; `depth` is the number of blocks enclosing them
 * (`0` at the top level).
 */
const parse_block = (
	tokens: Array<NginxToken>,
	cursor: { pos: number },
	open_line: number | null,
	depth: number
): Array<NginxDirective> => {
	const out: Array<NginxDirective> = [];
	for (;;) {
		const token = tokens[cursor.pos];
		if (token === undefined) {
			if (open_line !== null) {
				throw new NginxParseError(`unclosed \`{\` opened on line ${open_line}`);
			}
			return out;
		}
		if (token.kind === '}') {
			if (open_line === null) throw new NginxParseError(`unexpected \`}\` on line ${token.line}`);
			cursor.pos++;
			return out;
		}
		if (token.kind !== 'word') {
			throw new NginxParseError(`unexpected \`${token.kind}\` on line ${token.line}`);
		}
		const line = token.line;
		const args: Array<string> = [];
		for (;;) {
			const next = tokens[cursor.pos];
			if (next?.kind === 'word') {
				args.push(next.text);
				cursor.pos++;
			} else if (next?.kind === ';') {
				cursor.pos++;
				out.push({ args, line, block: null });
				break;
			} else if (next?.kind === '{') {
				if (depth >= MAX_NESTING_DEPTH) {
					throw new NginxParseError(
						`blocks nested deeper than ${MAX_NESTING_DEPTH} levels (line ${next.line})`
					);
				}
				cursor.pos++;
				const block = parse_block(tokens, cursor, next.line, depth + 1);
				out.push({ args, line, block });
				break;
			} else {
				throw new NginxParseError(
					`directive \`${args.join(' ')}\` on line ${line} is missing its \`;\``
				);
			}
		}
	}
};
