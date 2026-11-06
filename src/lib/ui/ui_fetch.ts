/**
 * Authenticated fetch helper for cookie-based session auth.
 *
 * Wraps the standard `fetch` with `credentials: 'include'` so cookies
 * are sent with every request. Use for all API calls in apps
 * that rely on `@fuzdev/fuz_app` session middleware.
 *
 * @module
 */

/**
 * Fetch with credentials included (sends cookies).
 */
export const ui_fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
	fetch(input, { ...init, credentials: 'include' });

/**
 * The text to show for an error body: its `message` when it carries one,
 * else its `error` code — a body's `error` is a machine-readable code, and
 * prose, when the server sends any, is in `message`.
 *
 * @param body - the parsed error body, of any shape
 * @param fallback - the text when the body has neither
 */
export const format_error_body = (body: unknown, fallback: string): string => {
	if (body === null || typeof body !== 'object') return fallback;
	const { message, error } = body as { message?: unknown; error?: unknown };
	if (typeof message === 'string' && message) return message;
	if (typeof error === 'string' && error) return error;
	return fallback;
};

/**
 * Safely extract an error message from a non-ok response: its `message`,
 * else its `error` code (`format_error_body`).
 *
 * Handles responses with non-JSON bodies (e.g. HTML 404 pages)
 * that would throw on `response.json()`.
 *
 * @param fallback - message when the body has no `message` or `error`
 */
export const parse_response_error = async (
	response: Response,
	fallback?: string
): Promise<string> => {
	const default_message = fallback ?? `Error: ${response.status}`;
	try {
		return format_error_body(await response.json(), default_message);
	} catch {
		return default_message;
	}
};
