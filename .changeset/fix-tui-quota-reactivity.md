---
"@sahiljassal/opencode-anthropic-auth": patch
---

Fix the quota sidebar freezing at its first-render values and never updating.

OpenCode's Solid JSX transform skips files under `node_modules`, which is
where npm-installed plugins load from (see
[opencode#33884](https://github.com/anomalyco/opencode/issues/33884)).
Without that transform, JSX props are evaluated once instead of compiled
into reactive getters, so the sidebar's `createSignal`/`createEffect`/`Show`
usage rendered correctly on first paint and then never changed again.

`tui.tsx` now renders a fixed tree once and drives all updates — quota
percentages, bars, and the "resets in ..." countdown — from a plain
`setInterval` writing directly to the rendered nodes, plus the existing
`message.updated`/`session.updated` event refresh. This has no dependency
on Solid's reactive transform, so it works the same whether the plugin
loads from `node_modules` or a local path.

Also switched `usedPercent` back to `Math.round` from `Math.ceil` (0.081
utilization now shows 8%, not 9%).
