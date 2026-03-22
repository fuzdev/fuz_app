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
	ok: boolean;
	warnings: Array<string>;
	errors: Array<string>;
}

/**
 * Extract location blocks from an nginx config string.
 *
 * Finds `location [= ] <path> {` directives and extracts the full block
 * content including nested braces. Returns the path and full block text.
 */
const extract_location_blocks = (config: string): Array<{path: string; content: string}> => {
	const blocks: Array<{path: string; content: string}> = [];
	const location_regex = /location\s+(?:=\s+)?(\S+)\s*\{/g;
	let match;
	while ((match = location_regex.exec(config)) !== null) {
		const path = match[1]!;
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
		blocks.push({path, content: config.slice(match.index, block_end)});
	}
	return blocks;
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
	const api_blocks = all_blocks.filter(
		(b) => b.path === '/api' || b.path.startsWith('/api/') || b.path.startsWith('/api{'),
	);
	if (api_blocks.length > 0) {
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
