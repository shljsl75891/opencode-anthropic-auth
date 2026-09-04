---
"@sahiljassal/opencode-anthropic-auth": minor
---

Add live Claude quota visibility in the OpenCode TUI sidebar (5h/7d window usage, reset countdown, fallback-advised flag). Quota headers are harvested from every Anthropic response and written to a local state file; a new `./tui` plugin entrypoint reads it and renders `sidebar_content` above the built-in sections.

Also ported two upstream SSE robustness fixes: bare-CR (`\r\r`) event delimiting and an oversized-line guard, in both the stripped-stream and server-side-fallback stream rewriters.
