/**
 * Installs the logged-error gate (`testing/logged_errors.ts`) in the `unit`
 * and `db` projects: every error a test logs fails it unless the test declares
 * it with `expect_logged_error` or `allow_logged_error`.
 *
 * Wired as a `setupFiles` entry of both projects in `vite.config.ts`, which
 * vitest re-imports per test file, so each file starts with fresh state.
 *
 * @module
 */

import { install_logged_error_gate } from '#lib/testing/logged_errors.ts';

install_logged_error_gate();
