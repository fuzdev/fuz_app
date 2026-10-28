---
'@fuzdev/fuz_app': minor
---

break: remove `TransitionFunction` and `PopoverTriggerParameters` (`ui/popover.svelte.ts`) — its `content` snippet was never read; `Popover.trigger` takes `PopoverParameters`. To migrate: pass `PopoverParameters` and drop `content`
