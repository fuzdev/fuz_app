/**
 * The untrusted-content hardening headers every served fact carries.
 *
 * Fact bytes are served with a producer-supplied `content_type` emitted
 * verbatim, inline. To stop a fact stored as (or sniffable to) `text/html` from
 * executing as stored XSS for any reader of a referencing cell, every fact
 * response carries `FACT_SECURITY_HEADERS`: `X-Content-Type-Options: nosniff` +
 * `Content-Security-Policy: default-src 'none'; sandbox`.
 *
 * The embedded and disk-stream branches of `server/serve_fact_route.ts` set them
 * on the response directly. On the `X-Accel-Redirect` branch nginx serves the
 * bytes from its internal facts location, and a location with its own
 * `add_header` stops the server-level headers from applying — so that location
 * must carry the set itself, as the lines `fact_security_header_directives`
 * renders. The X-Accel validator (`server/x_accel.ts`) refuses a facts location
 * without them.
 *
 * The Rust twin is `fuz_fact_serving::fact_security_headers`; both pin the same
 * literals.
 *
 * @module
 */

/**
 * `X-Content-Type-Options` for fact responses — block MIME sniffing so an
 * `application/octet-stream` fact can't be sniffed into executable HTML.
 */
export const FACT_X_CONTENT_TYPE_OPTIONS = 'nosniff';

/**
 * `Content-Security-Policy` for fact responses. A fact stored as (or sniffable
 * to) `text/html` would otherwise execute as stored XSS for any reader of a
 * referencing cell. `default-src 'none'; sandbox` neutralizes script execution
 * and sub-resource loads even when a fact is rendered inline; harmless for
 * directly-served images (they load no sub-resources).
 */
export const FACT_CONTENT_SECURITY_POLICY = "default-src 'none'; sandbox";

/**
 * The fact hardening headers, in render order. `Content-Disposition:
 * attachment` is deliberately absent — it would force-download and break
 * legitimate inline image rendering.
 */
export const FACT_SECURITY_HEADERS = {
	'X-Content-Type-Options': FACT_X_CONTENT_TYPE_OPTIONS,
	'Content-Security-Policy': FACT_CONTENT_SECURITY_POLICY
} as const;

/**
 * The exact nginx `add_header … always;` lines the internal facts location must
 * carry, rendered from `FACT_SECURITY_HEADERS`. `always` makes nginx add the
 * header on every status, not just 2xx/3xx. The X-Accel validator refuses a
 * facts location missing any of them.
 *
 * @returns one `add_header` directive per header, each ending in `always;`
 */
export const fact_security_header_directives = (): Array<string> =>
	Object.entries(FACT_SECURITY_HEADERS).map(
		([name, value]) => `add_header ${name} "${value}" always;`
	);
