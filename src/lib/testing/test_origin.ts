import './assert_dev_env.ts';

/**
 * The origin an in-process test request comes from, and the headers such a
 * request starts from. Dependency-free, so a cross-process suite reads it
 * without pulling in the server assembly `app_server.ts` builds on.
 *
 * @module
 */

/**
 * The origin an in-process test request comes from — the dev server's, and
 * the one origin `create_loopback_app_server_options` allows, so a request
 * carrying it passes the origin check. It is also the `Origin` `rpc_call`
 * sends cross-process, so a consumer's backend must allow it for `rpc_call`
 * to pass the backend's origin check.
 */
export const TEST_ORIGIN = 'http://localhost:5173';

/**
 * The headers every in-process test request starts from: `host: localhost`
 * and `TEST_ORIGIN`, which the loopback allow list admits.
 *
 * @param extra - headers added after, replacing either of the defaults
 * @returns a fresh object
 */
export const create_test_request_headers = (
	extra?: Record<string, string>
): Record<string, string> => ({
	host: 'localhost',
	origin: TEST_ORIGIN,
	...extra
});
