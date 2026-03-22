/**
 * Asserts that testing utilities are only imported in development environments.
 *
 * Each testing module imports this as a side effect to prevent accidental
 * inclusion in production bundles. Uses `esm-env` which is set correctly
 * by SvelteKit and Vite build tools — `DEV` is `true` during development
 * and testing, `false` in production builds.
 */

import {DEV} from 'esm-env';

if (!DEV) {
	throw new Error(
		'fuz_app testing utilities must not be imported in production. ' +
			'These modules are intended for use in test files only.',
	);
}
