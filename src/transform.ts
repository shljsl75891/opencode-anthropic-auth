import {
  ANTHROPIC_CACHE_LOOKBACK_BLOCKS,
  CLAUDE_CODE_IDENTITY,
  OPENCODE_IDENTITY_PREFIX,
  PARAGRAPH_REMOVAL_ANCHORS,
  REQUIRED_BETAS,
  TEXT_REPLACEMENTS,
  TOOL_PREFIX,
  USER_AGENT,
} from './constants.ts'

function prefixName(name: string): string {
  return `${TOOL_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

function unprefixName(name: string): string {
  if (name === 'StructuredOutput') {
    return name
  }
  return `${name.charAt(0).toLowerCase()}${name.slice(1)}`
}

export type FetchInput = string | URL | Request

/**
 * Merge headers from a Request object and/or a RequestInit headers value
 * into a single Headers instance.
 */
export function mergeHeaders(input: FetchInput, init?: RequestInit): Headers {
  const headers = new Headers()

  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      headers.set(key, value)
    })
  }

  const initHeaders = init?.headers
  if (initHeaders) {
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((value, key) => {
        headers.set(key, value)
      })
    } else if (Array.isArray(initHeaders)) {
      for (const entry of initHeaders) {
        const [key, value] = entry as [string, string]
        if (typeof value !== 'undefined') {
          headers.set(key, String(value))
        }
      }
    } else {
      for (const [key, value] of Object.entries(initHeaders)) {
        if (typeof value !== 'undefined') {
          headers.set(key, String(value))
        }
      }
    }
  }

  return headers
}

/**
 * Merge incoming beta headers with the required OAuth betas, deduplicating.
 */
export function mergeBetaHeaders(headers: Headers): string {
  const incomingBeta = headers.get('anthropic-beta') || ''
  const incomingBetasList = incomingBeta
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean)

  return [...new Set([...REQUIRED_BETAS, ...incomingBetasList])].join(',')
}

/**
 * Set OAuth-required headers: authorization, beta, user-agent.
 * Removes x-api-key since we're using OAuth.
 */
export function setOAuthHeaders(
  headers: Headers,
  accessToken: string,
): Headers {
  headers.set('authorization', `Bearer ${accessToken}`)
  headers.set('anthropic-beta', mergeBetaHeaders(headers))
  headers.set('user-agent', USER_AGENT)
  headers.delete('x-api-key')
  return headers
}

/**
 * Add TOOL_PREFIX to tool names in the request body.
 * Prefixes both tool definitions and tool_use blocks in messages.
 */
export function prefixToolNames(parsed: Record<string, unknown>): string {
  if (parsed.tools && Array.isArray(parsed.tools)) {
    parsed.tools = parsed.tools.map(
      (tool: { name?: string; [k: string]: unknown }) => ({
        ...tool,
        name: tool.name ? prefixName(tool.name) : tool.name,
      }),
    )
  }

  if (parsed.messages && Array.isArray(parsed.messages)) {
    parsed.messages = parsed.messages.map(
      (msg: {
        content?: Array<{
          type: string
          name?: string
          [k: string]: unknown
        }>
        [k: string]: unknown
      }) => {
        if (msg.content && Array.isArray(msg.content)) {
          msg.content = msg.content.map((block) => {
            if (block.type === 'tool_use' && block.name) {
              return { ...block, name: prefixName(block.name) }
            }
            return block
          })
        }
        return msg
      },
    )
  }

  return JSON.stringify(parsed)
}

/**
 * Strip TOOL_PREFIX from tool names in streaming response text.
 */
export function stripToolPrefix(text: string): string {
  return text.replace(
    /"name"\s*:\s*"mcp_([^"]+)"/g,
    (_match, name: string) => `"name": "${unprefixName(name)}"`,
  )
}

/**
 * Check if TLS verification should be skipped for custom API endpoints.
 * Only effective when ANTHROPIC_BASE_URL is also set.
 */
export function isInsecure(): boolean {
  if (!process.env.ANTHROPIC_BASE_URL?.trim()) return false
  const raw = process.env.ANTHROPIC_INSECURE?.trim()
  return raw === '1' || raw === 'true'
}

/**
 * Parse ANTHROPIC_BASE_URL from the environment.
 * Returns a valid HTTP(S) URL or null if unset/invalid.
 */
function resolveBaseUrl(): URL | null {
  const raw = process.env.ANTHROPIC_BASE_URL?.trim()
  if (!raw) return null
  try {
    const baseUrl = new URL(raw)
    if (
      (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') ||
      baseUrl.username ||
      baseUrl.password
    ) {
      return null
    }
    return baseUrl
  } catch {
    return null
  }
}

/**
 * Rewrite the request URL to add ?beta=true for /v1/messages requests.
 * When ANTHROPIC_BASE_URL is set, overrides the origin (protocol + host)
 * for all API requests flowing through the fetch wrapper.
 */
export function rewriteUrl(input: FetchInput): {
  input: FetchInput
  url: URL | null
} {
  let requestUrl: URL | null = null
  try {
    if (typeof input === 'string' || input instanceof URL) {
      requestUrl = new URL(input.toString())
    } else if (input instanceof Request) {
      requestUrl = new URL(input.url)
    }
  } catch {
    requestUrl = null
  }

  if (!requestUrl) return { input, url: null }

  const originalHref = requestUrl.href

  const baseUrl = resolveBaseUrl()
  if (baseUrl) {
    requestUrl.protocol = baseUrl.protocol
    requestUrl.host = baseUrl.host
  }

  if (
    requestUrl.pathname === '/v1/messages' &&
    !requestUrl.searchParams.has('beta')
  ) {
    requestUrl.searchParams.set('beta', 'true')
  }

  if (requestUrl.href === originalHref) {
    return { input, url: requestUrl }
  }

  const newInput =
    input instanceof Request
      ? new Request(requestUrl.toString(), input)
      : requestUrl
  return { input: newInput, url: requestUrl }
}

/**
 * Sanitize OpenCode-branded strings from the system prompt text.
 *
 * 1. Removes the OPENCODE_IDENTITY paragraph.
 * 2. Removes any paragraph (text between blank lines) that contains
 *    one of the PARAGRAPH_REMOVAL_ANCHORS — typically URLs that
 *    identify OpenCode-specific content.
 * 3. Applies TEXT_REPLACEMENTS for inline occurrences of "OpenCode"
 *    inside paragraphs we want to keep.
 *
 * This approach is resilient to upstream rewording of the OpenCode
 * prompt — as long as the anchor strings (URLs, etc.) still appear
 * somewhere in the paragraph, the removal works.
 */
export function sanitizeSystemText(text: string): string {
  const paragraphs = text.split(/\n\n+/)

  const filtered = paragraphs.filter((paragraph) => {
    if (paragraph.includes(OPENCODE_IDENTITY_PREFIX)) {
      return false
    }

    for (const anchor of PARAGRAPH_REMOVAL_ANCHORS) {
      if (paragraph.includes(anchor)) return false
    }

    return true
  })

  let result = filtered.join('\n\n')

  for (const rule of TEXT_REPLACEMENTS) {
    result = result.replace(rule.match, rule.replacement)
  }

  return result.trim()
}

type SystemBlock = { type: string; text: string; [k: string]: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

const CACHE_1H = { type: 'ephemeral', ttl: '1h' } as const

function removeCacheControl(value: unknown): void {
  if (!isRecord(value)) return
  delete value.cache_control
  delete value.cacheControl
}

function removeAllCacheControls(parsed: Record<string, unknown>): void {
  if (Array.isArray(parsed.system)) {
    for (const block of parsed.system) removeCacheControl(block)
  }
  if (!Array.isArray(parsed.messages)) return
  for (const msg of parsed.messages) {
    removeCacheControl(msg)
    if (isRecord(msg) && Array.isArray(msg.content)) {
      for (const block of msg.content) removeCacheControl(block)
    }
  }
}

function setWireCacheControl(value: unknown): boolean {
  if (!isRecord(value)) return false
  delete value.cacheControl
  value.cache_control = { ...CACHE_1H }
  return true
}

/**
 * Returns true for content block types that accept cache_control.
 * Anthropic rejects cache_control on thinking / redacted_thinking blocks
 * and silently skips empty text blocks without caching them.
 */
function isCacheableContentBlock(
  block: unknown,
): block is Record<string, unknown> {
  if (!isRecord(block)) return false
  if (block.type === 'thinking' || block.type === 'redacted_thinking')
    return false
  if (block.type === 'text' && !String(block.text ?? '').trim()) return false
  return true
}

/**
 * Normalises message content to an array of blocks, then filters to only
 * cacheable types. Returns undefined when there is nothing to anchor.
 */
function getCacheableContentBlocks(
  message: unknown,
): Record<string, unknown>[] | undefined {
  if (!isRecord(message)) return undefined

  let blocks: unknown[]
  if (Array.isArray(message.content)) {
    blocks = message.content
  } else if (typeof message.content === 'string') {
    const normalised = [{ type: 'text', text: message.content }]
    message.content = normalised
    blocks = normalised
  } else {
    return undefined
  }

  const cacheable = blocks.filter(isCacheableContentBlock)
  return cacheable.length > 0 ? cacheable : undefined
}

function messageContentBlockCount(message: unknown): number {
  return getCacheableContentBlocks(message)?.length ?? 0
}

function setMessageCacheAnchor(message: unknown): boolean {
  const blocks = getCacheableContentBlocks(message)
  if (!blocks) return false
  return setWireCacheControl(blocks[blocks.length - 1])
}

function setFirstMessageCacheAnchor(message: unknown): boolean {
  const blocks = getCacheableContentBlocks(message)
  if (!blocks) return false
  return setWireCacheControl(blocks[0])
}

function setSecondMessageCacheAnchor(message: unknown): boolean {
  const blocks = getCacheableContentBlocks(message)
  if (!blocks || blocks.length < 2) return false
  return setWireCacheControl(blocks[1])
}

type MessageAnchorPosition = {
  index: number
  blockCount: number
}

type HybridMessageAnchors = {
  latest: MessageAnchorPosition | undefined
  bridge: MessageAnchorPosition | undefined
}

/**
 * Walk all messages and collect user-role anchor positions.
 * Returns the `latest` position (index > 1) and a `bridge` position placed
 * whenever the cumulative block distance from bridge→latest exceeds
 * ANTHROPIC_CACHE_LOOKBACK_BLOCKS, ensuring both are within the sliding window.
 */
function selectHybridMessageAnchors(messages: unknown[]): HybridMessageAnchors {
  const userPositions: MessageAnchorPosition[] = messages
    .map((msg, index) => {
      if (!isRecord(msg)) return null
      if (msg.role !== 'user') return null
      const blockCount = messageContentBlockCount(msg)
      if (blockCount === 0) return null
      return { index, blockCount }
    })
    .filter((p): p is MessageAnchorPosition => p !== null)

  const rollingPositions = userPositions.filter((p) => p.index > 1)
  if (rollingPositions.length === 0) {
    return { latest: undefined, bridge: undefined }
  }

  // biome-ignore lint/style/noNonNullAssertion: guarded by length check above
  const latest = rollingPositions[rollingPositions.length - 1]!

  let bridge: MessageAnchorPosition | undefined
  let cumulativeBlocks = latest.blockCount
  for (let i = rollingPositions.length - 2; i >= 0; i--) {
    // biome-ignore lint/style/noNonNullAssertion: index is within bounds
    cumulativeBlocks += rollingPositions[i]!.blockCount
    if (cumulativeBlocks > ANTHROPIC_CACHE_LOOKBACK_BLOCKS) {
      bridge = rollingPositions[i]
      break
    }
  }

  return { latest, bridge }
}

function systemBlockText(block: unknown): string {
  return isRecord(block) && typeof block.text === 'string' ? block.text : ''
}

/**
 * Merge all plugin-added system instruction blocks (those after the primary
 * OpenCode/system prompt block) into a single block before placing the hybrid
 * system cache anchor.
 *
 * OpenCode normally emits these as one merged block, but some hooks can cause
 * them to arrive split across multiple blocks. Without coalescing, byte-
 * identical system text flips between merged/split layouts and moves the
 * cache_control breakpoint — busting the cache every turn.
 *
 * Block layout after prependClaudeCodeIdentity:
 *   [billing-header?] [identity] [primary system prompt] [plugin blocks…]
 * We preserve everything up to and including the primary prompt block and
 * merge all remaining plugin blocks into one.
 */
function coalesceHybridSystemTail(parsed: Record<string, unknown>): void {
  if (!Array.isArray(parsed.system)) return

  const system = parsed.system
  let prefixCount = 0

  if (
    systemBlockText(system[prefixCount]).startsWith(
      'x-anthropic-billing-header:',
    )
  ) {
    prefixCount++
  }
  if (systemBlockText(system[prefixCount]) === CLAUDE_CODE_IDENTITY) {
    prefixCount++
  }

  const tailStart = prefixCount + 1
  if (tailStart >= system.length - 1) return

  const firstTail = system[tailStart]
  if (!isRecord(firstTail)) return

  const mergedText = system.slice(tailStart).map(systemBlockText).join('\n')
  system.splice(tailStart, system.length - tailStart, {
    ...firstTail,
    type: 'text',
    text: mergedText,
  })
}

/**
 * Place a cache anchor on the last system block that follows the
 * CLAUDE_CODE_IDENTITY block. When there are no system blocks after the
 * identity, nothing is anchored.
 */
function setHybridSystemAnchor(parsed: Record<string, unknown>): void {
  if (!Array.isArray(parsed.system)) return

  const identityIdx = parsed.system.findIndex(
    (b) => isRecord(b) && b.text === CLAUDE_CODE_IDENTITY,
  )
  const afterIdentity = parsed.system
    .slice(identityIdx >= 0 ? identityIdx + 1 : 0)
    .filter(isRecord)

  setWireCacheControl(afterIdentity[afterIdentity.length - 1])
}

/**
 * Remove trailing assistant-role messages. OAuth endpoints reject requests
 * that end with an assistant turn (assistant prefill is not supported).
 */
function stripTrailingAssistantMessages(parsed: Record<string, unknown>): void {
  if (!Array.isArray(parsed.messages)) return
  while (
    parsed.messages.length > 0 &&
    isRecord(parsed.messages[parsed.messages.length - 1]) &&
    parsed.messages[parsed.messages.length - 1].role === 'assistant'
  ) {
    parsed.messages.pop()
  }
}

/**
 * Returns true when messages[0] carries a merged stable-prefix layout
 * (≥2 cacheable blocks). In that case anchoring the last block would bust
 * the cache every turn because the tail is volatile; instead we anchor
 * block[0] and block[1] (the two stable-prefix blocks).
 */
function isMagicContextLayout(blocks: Record<string, unknown>[]): boolean {
  return blocks.length >= 2
}

/**
 * Apply hybrid 1h prompt-caching breakpoints to parsed request body.
 *
 * Anthropic supports max 4 cache breakpoints per request. Slot allocation:
 *
 *   Slot 1 — system anchor: last block after identity.
 *             Skipped when a bridge is used (bridge takes that slot).
 *
 *   Slots 2+3 — messages[0]:
 *     • Normal layout (1 cacheable block): slot 2 = last block of msg[0];
 *       slot 3 = bridge message OR messages[1] (no bridge).
 *     • Magic-context layout (≥2 cacheable blocks): slot 2 = block[0],
 *       slot 3 = block[1]. messages[1] is skipped (msg[0] uses both slots).
 *
 *   Slot 4 — rolling latest: last user/tool-result message beyond index 1.
 *
 * Bridge and magic-context are independent: when both apply simultaneously,
 * the slot budget is: system(skipped) + msg0-block0 + bridge + latest = 4.
 * The bridge anchor is ALWAYS placed when detected, regardless of msg0 layout.
 */
function applyHybridCache1h(parsed: Record<string, unknown>): void {
  removeAllCacheControls(parsed)
  coalesceHybridSystemTail(parsed)

  const messages = Array.isArray(parsed.messages) ? parsed.messages : []
  const { latest, bridge } = selectHybridMessageAnchors(messages)

  if (!bridge) {
    setHybridSystemAnchor(parsed)
  }

  const msg0 = messages[0]
  const msg0Blocks = getCacheableContentBlocks(msg0)
  if (msg0Blocks && isMagicContextLayout(msg0Blocks)) {
    setFirstMessageCacheAnchor(msg0)
    setSecondMessageCacheAnchor(msg0)
  } else {
    setMessageCacheAnchor(msg0)
    if (!bridge) {
      setMessageCacheAnchor(messages[1])
    }
  }

  if (bridge) {
    setMessageCacheAnchor(messages[bridge.index])
  }

  if (latest) {
    setMessageCacheAnchor(messages[latest.index])
  }
}

/**
 * Sanitize system prompt and prepend Claude Code identity.
 * Handles all Anthropic API system formats: undefined, string, or array of text blocks.
 */
export function prependClaudeCodeIdentity(system: unknown): SystemBlock[] {
  const identityBlock: SystemBlock = {
    type: 'text',
    text: CLAUDE_CODE_IDENTITY,
  }

  if (system == null) return [identityBlock]

  if (typeof system === 'string') {
    const sanitized = sanitizeSystemText(system)
    if (sanitized === CLAUDE_CODE_IDENTITY) return [identityBlock]
    return [identityBlock, { type: 'text', text: sanitized }]
  }

  if (isRecord(system)) {
    const type = typeof system.type === 'string' ? system.type : 'text'
    const text = typeof system.text === 'string' ? system.text : ''
    return [identityBlock, { ...system, type, text: sanitizeSystemText(text) }]
  }

  if (!Array.isArray(system)) return [identityBlock]

  const sanitized: SystemBlock[] = system.map((item: unknown) => {
    if (typeof item === 'string') {
      return { type: 'text', text: sanitizeSystemText(item) }
    }

    if (
      isRecord(item) &&
      item.type === 'text' &&
      typeof item.text === 'string'
    ) {
      return {
        ...item,
        type: 'text',
        text: sanitizeSystemText(item.text),
      }
    }

    return { type: 'text', text: String(item) }
  })

  if (sanitized[0]?.text === CLAUDE_CODE_IDENTITY) {
    return sanitized
  }

  return [identityBlock, ...sanitized]
}

export function rewriteRequestBody(body: string): string {
  try {
    const parsed = JSON.parse(body)
    parsed.system = prependClaudeCodeIdentity(parsed.system)
    stripTrailingAssistantMessages(parsed)
    applyHybridCache1h(parsed)
    return prefixToolNames(parsed)
  } catch {
    return body
  }
}

/**
 * Error thrown when Anthropic emits a retryable server-side error inside
 * an HTTP 200 stream. OpenCode recognises ECONNRESET + anthropic-sse syscall
 * and applies its normal auto-retry flow instead of surfacing an unknown error.
 */
export type RetryableAnthropicStreamError = Error & {
  code: 'ECONNRESET'
  syscall: 'anthropic-sse'
  providerErrorType?: string
}

type SseErrorState = {
  pending: string
}

function findSseBoundary(
  value: string,
): { index: number; length: number } | null {
  const lf = value.indexOf('\n\n')
  const crlf = value.indexOf('\r\n\r\n')
  if (lf === -1) return crlf === -1 ? null : { index: crlf, length: 4 }
  if (crlf === -1 || lf < crlf) return { index: lf, length: 2 }
  return { index: crlf, length: 4 }
}

function asDiagnosticRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const v = record?.[key]
  return typeof v === 'string' ? v : undefined
}

function isRetryableAnthropicStreamError(
  errorType: string | undefined,
  message: string,
): boolean {
  const t = errorType?.toLowerCase()
  const m = message.toLowerCase()
  return (
    t === 'api_error' ||
    t === 'overloaded_error' ||
    t === 'server_error' ||
    t === 'internal_server_error' ||
    m.includes('internal server error') ||
    m.includes('server overloaded')
  )
}

function retryableAnthropicStreamError(
  errorType: string | undefined,
  message: string,
): RetryableAnthropicStreamError {
  const detail = errorType ? `${errorType}: ${message}` : message
  const err = new Error(
    `Anthropic stream error: ${detail}`,
  ) as RetryableAnthropicStreamError
  err.code = 'ECONNRESET'
  err.syscall = 'anthropic-sse'
  if (errorType) err.providerErrorType = errorType
  return err
}

function retryableAnthropicStreamErrorFromRawEvent(
  rawEvent: string,
): RetryableAnthropicStreamError | null {
  if (!rawEvent.includes('error')) return null

  let eventName: string | undefined
  const dataLines: string[] = []
  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      const v = line.slice('data:'.length)
      dataLines.push(v.startsWith(' ') ? v.slice(1) : v)
    }
  }

  const dataText = dataLines.join('\n')
  if (!dataText || dataText === '[DONE]') return null

  let parsed: unknown
  try {
    parsed = JSON.parse(dataText)
  } catch {
    return null
  }

  const data = asDiagnosticRecord(parsed)
  if (eventName !== 'error' && stringField(data, 'type') !== 'error')
    return null

  const errorObj = asDiagnosticRecord(data?.error)
  const errorType =
    stringField(errorObj, 'type') ?? stringField(errorObj, 'code') ?? undefined
  const message =
    stringField(errorObj, 'message') ??
    stringField(data, 'message') ??
    errorType ??
    'Anthropic stream error'

  if (!isRetryableAnthropicStreamError(errorType, message)) return null
  return retryableAnthropicStreamError(errorType, message)
}

function createSseErrorState(): SseErrorState {
  return { pending: '' }
}

function updateSseErrorState(
  state: SseErrorState,
  text: string,
): RetryableAnthropicStreamError | null {
  if (!text) return null
  state.pending += text

  while (true) {
    const boundary = findSseBoundary(state.pending)
    if (!boundary) break

    const rawEvent = state.pending.slice(0, boundary.index)
    state.pending = state.pending.slice(boundary.index + boundary.length)
    const err = retryableAnthropicStreamErrorFromRawEvent(rawEvent)
    if (err) return err
  }

  return null
}

/**
 * Rewrite the tool prefix from the safe portion of a text buffer.
 * Holds back any suffix that could be the start of a partial `"name"` marker
 * spanning a chunk boundary. Pass flush=true on stream end to emit everything.
 */
function splitToolPrefixRewriteBuffer(
  buffer: string,
  flush = false,
): { ready: string; pending: string } {
  if (flush) return { ready: stripToolPrefix(buffer), pending: '' }

  let keepFrom = buffer.length
  const marker = '"name"'

  const partialStart = Math.max(0, buffer.length - marker.length + 1)
  for (let i = partialStart; i < buffer.length; i++) {
    if (marker.startsWith(buffer.slice(i))) {
      keepFrom = Math.min(keepFrom, i)
      break
    }
  }

  const lastMarker = buffer.lastIndexOf(marker)
  if (lastMarker !== -1) {
    const tail = buffer.slice(lastMarker)
    if (/^"name"\s*(?::\s*(?:"[^"]*)?)?$/.test(tail)) {
      keepFrom = Math.min(keepFrom, lastMarker)
    }
  }

  if (keepFrom < buffer.length) {
    return {
      ready: stripToolPrefix(buffer.slice(0, keepFrom)),
      pending: buffer.slice(keepFrom),
    }
  }

  return { ready: stripToolPrefix(buffer), pending: '' }
}

/**
 * Create a streaming response that strips the tool prefix from tool names.
 * Detects retryable Anthropic server errors inside HTTP 200 streams and
 * throws a connection-reset-style error so OpenCode can auto-retry.
 */
export function createStrippedStream(response: Response): Response {
  if (!response.body) return response

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ''
  let readerReleased = false
  const sseErrors = createSseErrorState()

  const releaseReader = () => {
    if (readerReleased) return
    readerReleased = true
    reader.releaseLock()
  }

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()

        if (done) {
          const finalDecoded = decoder.decode()
          let retryableError = updateSseErrorState(sseErrors, finalDecoded)
          if (!retryableError && sseErrors.pending) {
            retryableError = retryableAnthropicStreamErrorFromRawEvent(
              sseErrors.pending,
            )
          }
          if (retryableError) {
            try {
              await reader.cancel()
            } catch {
              /* ignore cancel failure */
            }
            releaseReader()
            throw retryableError
          }

          const { ready } = splitToolPrefixRewriteBuffer(
            `${pending}${finalDecoded}`,
            true,
          )
          if (ready) controller.enqueue(encoder.encode(ready))
          releaseReader()
          controller.close()
          return
        }

        const decoded = decoder.decode(value, { stream: true })
        const retryableError = updateSseErrorState(sseErrors, decoded)
        if (retryableError) {
          try {
            await reader.cancel()
          } catch {
            /* ignore cancel failure */
          }
          releaseReader()
          throw retryableError
        }

        const { ready, pending: nextPending } = splitToolPrefixRewriteBuffer(
          pending + decoded,
        )
        pending = nextPending
        if (ready) controller.enqueue(encoder.encode(ready))
      } catch (error) {
        releaseReader()
        throw error
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        releaseReader()
      }
    },
  })

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
