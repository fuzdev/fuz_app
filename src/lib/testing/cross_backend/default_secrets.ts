import '../assert_dev_env.ts';

/**
 * Default test secrets for cross-process backend bootstrap.
 *
 * Every cross-backend consumer needs the same shape: a bootstrap token
 * the harness writes to disk before spawn, a keeper username/password
 * the harness POSTs to `/api/account/bootstrap`, and cookie keys the
 * binary uses to construct its `Keyring`. The literals here are dev-only
 * and protected by `assert_dev_env`; the binaries themselves throw on
 * production load.
 *
 * Each constant is exported individually so consumers can override one
 * without re-deriving the rest. Builders in `testing/cross_backend/default_backend_configs.ts`
 * thread these defaults into the `BackendConfig.bootstrap` block and the
 * `SECRET_FUZ_COOKIE_KEYS` env entry; callers compose the
 * `bootstrap_overrides` knob when they need a non-default keeper.
 *
 * @module
 */

/**
 * Fixed bootstrap token written to each backend's `token_path` before
 * spawn. The test binary reads + consumes this via its
 * `*_BOOTSTRAP_TOKEN_PATH` env var; the harness POSTs the same token to
 * `/api/account/bootstrap` to mint the keeper account. Any 32+ char
 * string works — the binary just compares bytes, no entropy required
 * for tests.
 */
export const default_test_bootstrap_token = 'test_bootstrap_token_for_cross_be';

/** Keeper username used by every cross-process test fixture. */
export const default_test_keeper_username = 'keeper';

/** Keeper password used by every cross-process test fixture. */
export const default_test_keeper_password = 'password_test_keeper';

/**
 * Dev-only cookie keys (64+ chars). The test binary needs
 * `SECRET_FUZ_COOKIE_KEYS` to construct its `Keyring`. Never used in
 * production — the test binaries themselves throw on production load
 * via `assert_dev_env`.
 */
export const default_test_cookie_keys =
	'dev_only_cookie_keys_for_cross_backend_tests_not_for_prod_use_xx';
