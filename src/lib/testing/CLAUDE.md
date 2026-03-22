# testing/

Every module in this directory starts with `import './assert_dev_env.js';` as its first line. This side-effect import throws at runtime if `DEV` (from `esm-env`) is false, preventing accidental inclusion in production bundles. Always add this import as the first line when creating new testing modules.
