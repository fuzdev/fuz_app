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
 *
 * @param input - the request URL or Request object
 * @param init - optional fetch init options
 * @returns fetch response promise
 */
export const ui_fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
	fetch(input, {...init, credentials: 'include'});

/**
 * Safely extract an error message from a non-ok response.
 *
 * Handles responses with non-JSON bodies (e.g. HTML 404 pages)
 * that would throw on `response.json()`.
 *
 * @param response - the non-ok response
 * @param fallback - fallback message when no `.error` field is found
 * @returns error message string
 */
export const parse_response_error = async (
	response: Response,
	fallback?: string,
): Promise<string> => {
	const default_message = fallback ?? `Error: ${response.status}`;
	try {
		const data = await response.json();
		return typeof data?.error === 'string' ? data.error : default_message;
	} catch {
		return default_message;
	}
};
