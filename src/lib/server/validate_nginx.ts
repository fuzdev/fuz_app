/**
 * String-based nginx config validator for fuz_app deploy configs.
 *
 * Checks consumer `NGINX_CONFIG` template strings for required security
 * properties. This is pattern matching on template strings, not a real
 * nginx parser — it catches common security omissions but won't catch
 * all possible misconfigurations.
 *
 * @module
 */

/**
 * Result of validating an nginx config template string.
 */
export interface NginxValidationResult {
	/** True when no errors were detected. Warnings do not affect this flag. */
	ok: boolean;
	/** Non-fatal issues — missing optional headers, weakened defaults, etc. */
	warnings: Array<string>;
	/** Fatal issues — missing `/api` block, missing required security headers, etc. */
	errors: Array<string>;
}

/**
 * A parsed nginx `location` directive with its modifier, path, and raw content.
 *
 * The modifier (`=`, `~`, `~*`, `^~`, or `''` for a plain prefix match) changes
 * how nginx matches the request URI. We capture it so `/api` matching can
 * reason about the semantics: regex locations (`~`, `~*`) use anchors like
 * `^/api(/|$)`, prefix locations match the literal string.
 */
interface LocationBlock {
	modifier: string;
	path: string;
	content: string;
}

/**
 * Extract location blocks from an nginx config string.
 *
 * Finds `location [modifier] <path> {` directives (modifier may be `=`, `~`,
 * `~*`, `^~`, or absent) and returns the full block content including nested
 * braces.
 */
const extract_location_blocks = (config: string): Array<LocationBlock> => {
	const blocks: Array<LocationBlock> = [];
	const location_regex = /location\s+(=|~\*?|\^~)?\s*(\S+)\s*\{/g;
	let match;
	while ((match = location_regex.exec(config)) !== null) {
		const modifier = match[1] ?? '';
		const path = match[2]!;
		const open_brace_index = match.index + match[0].length - 1;
		let depth = 1;
		let block_end = open_brace_index + 1;
		for (let i = open_brace_index + 1; i < config.length; i++) {
			if (config[i] === '{') depth++;
			else if (config[i] === '}') {
				depth--;
				if (depth === 0) {
					block_end = i + 1;
					break;
				}
			}
		}
		blocks.push({modifier, path, content: config.slice(match.index, block_end)});
	}
	return blocks;
};

/**
 * Canonical `/api` URIs used to probe regex location patterns.
 *
 * Two probes cover the common regex shapes:
 * - `/api` catches `^/api$`, `^/api(/|$)`, `^/(admin|api)`, etc.
 * - `/api/` catches `^/api/` (which requires the trailing slash).
 *
 * Only consulted from the regex branch of `location_matches_api` — non-regex
 * blocks compare `block.path` literally.
 */
const API_TEST_URIS: ReadonlyArray<string> = ['/api', '/api/'];

/**
 * Does a location block route `/api` traffic?
 *
 * The matching strategy is deliberately asymmetric across modifier types:
 *
 * - **Regex (`~`, `~*`)**: compiles `block.path` as a regex and tests it
 *   against `API_TEST_URIS`. `~*` gets the `i` flag. Any match flags the
 *   block as `/api`-handling. Invalid regex returns `false` (nginx would
 *   reject it too). URI-probing is needed because regex patterns don't
 *   admit a reliable substring check — `^/(admin|api)` has no `/api` prefix
 *   textually but routes `/api` traffic.
 * - **Prefix (no modifier, `^~`) and exact (`=`)**: literal check —
 *   `block.path === '/api'` or `block.path.startsWith('/api/')`. We do NOT
 *   probe with `API_TEST_URIS` here because that would produce false
 *   positives on overly broad prefixes: a catch-all `location /` technically
 *   routes `/api` requests, but nginx would prefer a more specific `/api`
 *   block when one exists — and we want the separate "No /api block found"
 *   error when one doesn't.
 *
 * Known blind spot: a regex matching only a sub-path that isn't in
 * `API_TEST_URIS` (e.g. `^/api/v99$`, or `^/api/.+` which requires content
 * after the slash) won't be flagged. Acceptable for fuz_app deploy configs,
 * which route all `/api` traffic through a single broad block.
 */
const location_matches_api = (block: LocationBlock): boolean => {
	if (block.modifier === '~' || block.modifier === '~*') {
		try {
			const re = new RegExp(block.path, block.modifier === '~*' ? 'i' : '');
			return API_TEST_URIS.some((uri) => re.test(uri));
		} catch {
			return false;
		}
	}
	return block.path === '/api' || block.path.startsWith('/api/');
};

/**
 * Validate an nginx config template string for security properties.
 *
 * Checks for required security headers, Authorization stripping in `/api`
 * blocks, and the nginx `add_header` inheritance gotcha. Designed for
 * fuz_app consumer deploy configs (tx.ts `NGINX_CONFIG` constants).
 *
 * Limitations: string pattern matching, not a real nginx parser. Catches
 * common omissions in fuz_app deploy configs but won't catch all possible
 * misconfigurations.
 *
 * @param config - nginx config template string
 * @returns validation result with ok status, warnings, and errors
 */
export const validate_nginx_config = (config: string): NginxValidationResult => {
	const errors: Array<string> = [];
	const warnings: Array<string> = [];

	const all_blocks = extract_location_blocks(config);

	// 1. proxy_set_header Authorization "" in /api location blocks
	const api_blocks = all_blocks.filter(location_matches_api);
	if (api_blocks.length === 0) {
		errors.push(
			'No /api location block found — config must have an /api location block ' +
				'with Authorization header stripping. If you intentionally route /api ' +
				'through a different structure, skip this validator.',
		);
	} else {
		const has_auth_strip = api_blocks.some(
			(block) =>
				block.content.includes('proxy_set_header Authorization ""') ||
				block.content.includes("proxy_set_header Authorization ''"),
		);
		if (!has_auth_strip) {
			errors.push(
				'Missing `proxy_set_header Authorization ""` in /api location block — ' +
					'required for v1 cookie-only external auth posture',
			);
		}
	}

	// 2. Strict-Transport-Security (error if missing)
	if (!config.includes('Strict-Transport-Security')) {
		errors.push('Missing Strict-Transport-Security header');
	}

	// 3. X-Content-Type-Options "nosniff" (warning if missing)
	if (!config.includes('X-Content-Type-Options')) {
		warnings.push('Missing X-Content-Type-Options "nosniff" header');
	}

	// 4. X-Frame-Options (warning if missing)
	if (!config.includes('X-Frame-Options')) {
		warnings.push('Missing X-Frame-Options header');
	}

	// 5. Referrer-Policy (warning if missing)
	if (!config.includes('Referrer-Policy')) {
		warnings.push('Missing Referrer-Policy header');
	}

	// 6. server_tokens off (warning if missing)
	if (!config.includes('server_tokens off')) {
		warnings.push('Missing server_tokens off — nginx version may be disclosed');
	}

	// 7. limit_req (warning if missing — may be in a separate rate_limit.conf)
	if (!config.includes('limit_req')) {
		warnings.push(
			'Missing limit_req — may be in a separate rate_limit.conf. ' +
				'Consider adding nginx-level rate limiting',
		);
	}

	// 8. X-Forwarded-For: prefer $remote_addr over $proxy_add_x_forwarded_for
	if (config.includes('$proxy_add_x_forwarded_for')) {
		warnings.push(
			'Using $proxy_add_x_forwarded_for — prefer $remote_addr for single-proxy setups ' +
				'to avoid client-injected XFF headers',
		);
	}

	// 9. Child location blocks with add_header must repeat security headers
	for (const block of all_blocks) {
		if (
			block.content.includes('add_header') &&
			!block.content.includes('Strict-Transport-Security')
		) {
			// Only flag child locations that add their own response headers
			// (Cache-Control, Content-Disposition, etc.) — these override
			// inherited headers from the parent server block
			if (
				block.content.includes('Cache-Control') ||
				block.content.includes('Content-Disposition')
			) {
				warnings.push(
					`Location ${block.path} has add_header but is missing Strict-Transport-Security — ` +
						'nginx add_header in child blocks replaces (not extends) inherited headers',
				);
			}
		}
	}

	return {
		ok: errors.length === 0,
		warnings,
		errors,
	};
};
