---
'@fuzdev/fuz_app': minor
---

break: a bootstrap sets the daemon-token keeper itself; `on_bootstrap` is gone

- break: remove `OnBootstrap`, `BootstrapRouteOptions.on_bootstrap`, `BootstrapLiveOptions.on_bootstrap` (`AppServerOptions.bootstrap`) and `BootstrapAccountCreated`; `BootstrapAccountSuccess` no longer carries `role_grants`
- break: `BootstrapRouteOptions` takes a required `daemon_token_state: DaemonTokenState | null`; once a bootstrap commits, the route sets its `keeper_account_id` to the new account (`create_app_server` passes its `daemon_token_state`), as the Rust spine's `on_keeper_resolved` wiring does — a rolled-back bootstrap sets nothing
- break: the daemon-token middleware no longer re-reads the keeper from the database while `keeper_account_id` is null; `create_app_server` resolves it at assembly for a passed `daemon_token_state` whose keeper is null (as the Rust spine's boot runs `resolve_keeper_into`), and the bootstrap route sets it after its commit, logging the Rust spine's `daemon token: keeper account set by bootstrap` (`_testing_reset` sets it to its fresh keeper), so a keeper seeded by another process (`seed_dev_account`) authenticates by daemon token after a restart, as on the Rust spine
