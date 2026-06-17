# opencode-anthropic-auth

> [!WARNING]
> This plugin comes with no guarantees. You might be banned for breaking the TOS, you might not be. I don't work at Anthropic, nor am I an attorney.
>
> Use your best judgment and don't abuse your subscription.

Fork of [ex-machina-co/opencode-anthropic-auth](https://github.com/ex-machina-co/opencode-anthropic-auth), with caching improvements inspired by [cortexkit/anthropic-auth](https://github.com/cortexkit/anthropic-auth).

An [OpenCode](https://github.com/anomalyco/opencode) plugin that provides Anthropic OAuth authentication, enabling Claude Pro/Max users to use their subscription directly with OpenCode.

## Install

Add to your OpenCode config (`~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["@sahiljassal/opencode-anthropic-auth"]
}
```

## Authentication Methods

- **Claude Pro/Max** — OAuth flow via `claude.ai`. Uses your existing subscription at no additional API cost.
- **Create an API Key** — OAuth flow via `console.anthropic.com` that creates an API key on your behalf.
- **Manually enter API Key** — Standard API key entry.

## Prompt Caching

This fork applies **hybrid 1-hour ephemeral prompt caching** on every request, placing up to 4 breakpoints strategically:

| Breakpoint | Behaviour |
|---|---|
| **System anchor** | Last system block after the identity block (skipped when bridge occupies the slot) |
| **messages[0]** | Magic-context split: anchors block[0] + block[1] when stable prefix and volatile delta are merged; otherwise anchors the last cacheable block |
| **messages[1] / bridge** | Last cacheable block of messages[1]; replaced by a bridge anchor when a tool-heavy session pushes the latest user boundary outside Anthropic's 20-block lookback window |
| **Rolling latest** | Most recent user message beyond index 1, keeping cache hot across long sessions |

Additional behaviours:

- **System tail coalescing** — plugin-added system blocks beyond the primary prompt are merged into one block before placing the system anchor, preventing cache busts when block layout changes between requests
- **Trailing assistant strip** — assistant messages at the tail of the request are removed before forwarding (OAuth rejects assistant prefill)
- **Thinking block guard** — `thinking` and `redacted_thinking` blocks are excluded from cache anchor placement; messages containing only thinking blocks receive no `cache_control` (avoids Anthropic 400)
- **SSE retryable errors** — transient server errors (`api_error`, `overloaded_error`, `server_error`) emitted inside HTTP 200 streams are detected and thrown as connection-reset errors so OpenCode auto-retries
- **Buffered stream rewriting** — tool name stripping buffers partial `"name"` tokens across chunk boundaries to avoid corruption

## Configuration

| Variable             | Description                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `ANTHROPIC_BASE_URL` | Override API endpoint URL (e.g. for proxying). Must be a valid HTTP(S) URL.              |
| `ANTHROPIC_INSECURE` | Set to `1` or `true` to skip TLS verification. Only effective with `ANTHROPIC_BASE_URL`. |

## License

MIT
