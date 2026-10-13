---
'@fuzdev/fuz_app': minor
---

**breaking** chore: remove the unused `env/resolve.ts` — the `$$VAR$$` reference suite (`resolve_env_vars`, `has_env_vars`, `get_env_var_names`, `resolve_env_vars_in_object`, `resolve_env_vars_required`, `scan_env_vars`, `validate_env_vars`, `format_missing_env_vars`, and the types `EnvVarRef`, `EnvValidationResult`, `FormatMissingEnvVarsOptions`). Nothing in the package used it, and there is no replacement
