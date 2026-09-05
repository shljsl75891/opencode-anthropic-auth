---
"@sahiljassal/opencode-anthropic-auth": patch
---

Tighten prompt-cache prefix stability in two places.

**Parallel tool calls no longer shrink the cache bridge.** Anthropic's
20-block cache lookback counts a run of consecutive `tool_use` blocks —
or of consecutive `tool_result` blocks — as a single position. The bridge
anchor's distance math was counting every block, so a turn with many
parallel tool calls overflowed the window early and placed the bridge
nearer than necessary, leaving older cached prefix unreachable. Runs now
count as one position, matching the documented behaviour.

Fixing that also surfaced an existing off-by-one in the same distance
math: the walk started one message before the latest anchor, so neither
the latest anchor's own blocks nor the candidate bridge's own anchor block
counted toward the 20-position limit. That let the bridge land outside
Anthropic's actual reachable window. Both anchors' own positions are now
included, matching Anthropic's documented rule that the lookback counts
the breakpoint itself as the first position.

**Tool definitions are sorted by name.** A change anywhere in `tools[]`
invalidates the entire cached prefix. MCP servers that attach after the
first turn could reorder the array between requests; sorting makes the
order deterministic regardless of attach timing.
