---
'@fuzdev/fuz_app': patch
---

feat: `SetupFlowLogger` and `default_setup_flow_logger` in `dev/setup.ts`, and the `create_recording_setup_flow_logger` test double in `testing/setup_logger_helpers.ts`

- feat: `SetupFlowLogger` extends `SetupLogger` with `print` (a plain line to stdout) and `print_error` (a plain line to stderr), the sink of a consumer's setup flow, passed to the `dev/setup.ts` helpers as their `SetupLogger` too; `default_setup_flow_logger` is `default_setup_logger` plus `console.log` and `console.error`
- feat: `create_recording_setup_flow_logger()` (`testing/setup_logger_helpers.ts`) records each call as `[method, msg]` in `entries`, and `setup_flow_log_messages(log, method)` reads one method's messages. To migrate: a consumer with its own copy deletes its local `SetupFlowLogger` module and recorder, imports these, and renames `console_setup_flow_logger` → `default_setup_flow_logger` and `messages_of` → `setup_flow_log_messages`
