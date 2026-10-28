/**
 * Wildcard allowlist entries — refused at server assembly unless the operator
 * opts in (`FUZ_ALLOW_ORIGIN_WILDCARDS=true`), and said aloud on every boot
 * that admits them. Twin of the Rust `fuz_http::origin_wildcard`, word for
 * word.
 *
 * Wildcards are origin syntax an operator may want, but each one admits pages
 * the server does not serve, and the server trusts them all. The forms, as
 * `parse_allowed_origins` matches them (`OriginWildcard`):
 *
 * - **port** (`:*`) — the host at any port, or none;
 * - **host** — each `*` label is any one label, in any position
 *   (`https://*.example.com`, `https://example.*`), and a host that is all
 *   `*` labels (`http://*`, `https://*.*`) is every host with that many
 *   labels — four of them cover every IPv4 address;
 * - **both** (`http://*:*`, `https://*.example.com:*`).
 *
 * A bracketed IPv6 host is exact, so it takes only the port form.
 *
 * @module
 */

import type { Result } from '@fuzdev/fuz_util/result.ts';

import { origin_pattern_of, type OriginPattern } from './origin.ts';

/** The env var the allowlist is read from (`BaseServerEnv`). */
export const ALLOWED_ORIGINS_VAR = 'FUZ_ALLOWED_ORIGINS';

/**
 * The env var that admits wildcard allowlist entries: exactly `true` admits
 * them, exactly `false` (or unset) refuses them, and anything else fails the
 * env schema (`BaseServerEnv`).
 */
export const ALLOW_ORIGIN_WILDCARDS_VAR = 'FUZ_ALLOW_ORIGIN_WILDCARDS';

/** How much of a pattern's host its `*` labels leave open. */
export type HostWildcard =
	/** Some labels are fixed (`*.example.com`, `example.*`). */
	| { kind: 'partial' }
	/** No label is fixed (`*`, `*.*`): every host of `labels` labels. */
	| { kind: 'whole'; labels: number };

/** The wildcards an `OriginPattern` holds — `origin_wildcard_kind`. */
export type OriginWildcard =
	| { kind: 'port' }
	| { kind: 'host'; host: HostWildcard }
	| { kind: 'host_and_port'; host: HostWildcard };

/**
 * Which wildcards `pattern` holds, `null` for an exact entry.
 *
 * @param pattern - a parsed allowlist entry
 * @returns its wildcard shape, or `null`
 */
export const origin_wildcard_kind = (pattern: OriginPattern): OriginWildcard | null => {
	let host: HostWildcard | null = null;
	if (pattern.host_labels !== null) {
		const any = pattern.host_labels.filter((label) => label === '*').length;
		if (any > 0) {
			host =
				any < pattern.host_labels.length
					? { kind: 'partial' }
					: { kind: 'whole', labels: pattern.host_labels.length };
		}
	}
	const any_port = pattern.port === 'any';
	if (host === null) return any_port ? { kind: 'port' } : null;
	return any_port ? { kind: 'host_and_port', host } : { kind: 'host', host };
};

/**
 * What a wildcard in `pattern` admits — the text `admit_origin_wildcards`
 * warns or refuses with; `null` for an exact entry. The TS spine mounts no
 * `Host` check and adds no note, so this is the Rust text with
 * `OriginWildcardOptions::DEFAULT`.
 *
 * @param pattern - a parsed allowlist entry
 * @returns the text, or `null`
 */
export const origin_wildcard_warning = (pattern: OriginPattern): string | null => {
	const wildcard = origin_wildcard_kind(pattern);
	if (wildcard === null) return null;
	const { host } = pattern;
	const kind =
		wildcard.kind === 'port'
			? 'port wildcard'
			: wildcard.kind === 'host'
				? 'host wildcard'
				: 'host and port wildcard';
	const host_wildcard = wildcard.kind === 'port' ? null : wildcard.host;
	let hosts: string;
	if (host_wildcard === null) {
		hosts = `\`${host}\``;
	} else if (host_wildcard.kind === 'partial') {
		hosts = `ANY host matching \`${host}\` (each \`*\` is any one label)`;
	} else {
		const { labels } = host_wildcard;
		const every =
			labels === 1
				? 'every single-label name, `localhost` included'
				: labels === 4
					? 'every IPv4 address and every four-label hostname'
					: `every hostname of ${labels} labels`;
		hosts = `ANY host of that shape (no label of \`${host}\` is fixed: ${every})`;
	}
	const ports =
		pattern.port === 'any' ? 'ANY port on ' : pattern.port === 'exact' ? 'that port on ' : '';
	return (
		`${kind}: a page served from ${ports}${hosts} is an allowed origin. The server trusts ` +
		'every such page: one that is same-site with the host you log in at carries the ' +
		'session cookie, and with it can call the API and open the WebSocket. ' +
		'Name exact origins unless every such page is trusted'
	);
};

/** One wildcard entry an allowlist holds, with what it admits. */
export interface OriginWildcardEntry {
	readonly entry: string;
	readonly warning: string;
}

/**
 * Admit `origins`' wildcard entries when `allowed`, returning what each admits
 * for the caller to warn with; an exact list passes either way with none.
 * Classifies the matchers `parse_allowed_origins` built (`origin_pattern_of`,
 * read through a realm-global brand, so a second fuz_app copy's matchers
 * classify too). A matcher built any other way can't be classified, so it is
 * refused whatever `allowed` says — build the list with
 * `parse_allowed_origins`.
 *
 * @param origins - the allowlist's matchers
 * @param allowed - whether the operator opted in (`FUZ_ALLOW_ORIGIN_WILDCARDS=true`)
 * @param origins_var - what the list is called in the refusal: the env var it
 *   was read from, or the option that carried it
 * @returns the wildcard entries admitted, or the refusal — naming each
 *   unclassifiable matcher, or else each wildcard entry, what it admits, and
 *   the flag (the Rust spine's boot error, word for word)
 */
export const admit_origin_wildcards = (
	origins: ReadonlyArray<RegExp>,
	allowed: boolean,
	origins_var: string = ALLOWED_ORIGINS_VAR
): Result<{ wildcards: Array<OriginWildcardEntry> }, { message: string }> => {
	const wildcards: Array<OriginWildcardEntry> = [];
	const unparsed: Array<RegExp> = [];
	for (const regexp of origins) {
		const pattern = origin_pattern_of(regexp);
		if (!pattern) {
			unparsed.push(regexp);
			continue;
		}
		const warning = origin_wildcard_warning(pattern);
		if (warning) wildcards.push({ entry: pattern.entry, warning });
	}
	if (unparsed.length > 0) {
		const matchers = unparsed.map((r) => `\`${String(r)}\``).join(', ');
		return {
			ok: false,
			message:
				`${origins_var} holds a matcher \`parse_allowed_origins\` did not build, ` +
				`so its wildcards can't be checked: ${matchers}. ` +
				'Build the list with `parse_allowed_origins`.'
		};
	}
	if (wildcards.length === 0 || allowed) return { ok: true, wildcards };
	const entries = wildcards.map((w) => `\`${w.entry}\`: ${w.warning}.`).join(' ');
	return {
		ok: false,
		message:
			`${origins_var} holds a wildcard entry, refused unless ` +
			`${ALLOW_ORIGIN_WILDCARDS_VAR}=true. ${entries}`
	};
};
