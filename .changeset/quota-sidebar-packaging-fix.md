---
"@sahiljassal/opencode-anthropic-auth": patch
---

Fix the TUI sidebar silently failing to load when installed from npm: the published `files` list included `src/tui.tsx` but not the sibling modules it imports at runtime (`src/quota-format.ts`, `src/quota-headers.ts`, `src/quota-state.ts`), so the import resolved nothing outside a local checkout. Added a packaging test that walks the relative-import graph from `src/tui.tsx` and asserts every reachable file is included in `npm pack`'s file list.
