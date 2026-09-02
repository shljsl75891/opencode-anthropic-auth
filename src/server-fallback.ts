/**
 * Anthropic's server-side safety fallback (`server-side-fallback-2026-07-01`)
 * transparently reroutes a refused Fable 5/Opus 5 request to Opus 5/Opus 4.8
 * instead of returning a content-filter refusal. Opting OAuth requests into
 * it means the returned `fallback` content block records the handoff.
 * OpenCode has no concept of that block type, so it can't be persisted or
 * replayed as-is — this module hides it behind a signed `thinking` marker on
 * the way out and restores the original block on the way back in.
 */

export const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01'

const MARKER_TEXT = '\u2060'
const SIGNATURE_PREFIX = 'opencode-anthropic-auth-server-fallback-v1:'
const RECOVERABLE_REFUSAL_MODEL_PATTERN = /^claude-(fable-5|opus-5)(-.*)?$/i

type FallbackMarker = {
  fromModel: string
  toModel: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringField(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const field = value?.[key]
  return typeof field === 'string' ? field : undefined
}

export function isRecoverableRefusalModel(model: unknown): model is string {
  return (
    typeof model === 'string' && RECOVERABLE_REFUSAL_MODEL_PATTERN.test(model)
  )
}

function encodeMarkerSignature(marker: FallbackMarker) {
  return `${SIGNATURE_PREFIX}${marker.fromModel}|${marker.toModel}`
}

function decodeMarkerSignature(value: unknown): FallbackMarker | null {
  if (typeof value !== 'string' || !value.startsWith(SIGNATURE_PREFIX)) {
    return null
  }
  const encoded = value.slice(SIGNATURE_PREFIX.length)
  const separator = encoded.indexOf('|')
  if (separator <= 0 || separator !== encoded.lastIndexOf('|')) return null
  const fromModel = encoded.slice(0, separator)
  const toModel = encoded.slice(separator + 1)
  if (!fromModel || !toModel) return null
  return { fromModel, toModel }
}

function markerFromFallbackBlock(
  block: Record<string, unknown>,
): FallbackMarker | null {
  if (block.type !== 'fallback') return null
  const fromModel = stringField(
    isRecord(block.from) ? block.from : undefined,
    'model',
  )
  const toModel = stringField(
    isRecord(block.to) ? block.to : undefined,
    'model',
  )
  if (!fromModel || !toModel) return null
  return { fromModel, toModel }
}

function fallbackBlock(marker: FallbackMarker) {
  return {
    type: 'fallback',
    from: { model: marker.fromModel },
    to: { model: marker.toModel },
  }
}

function rewriteStoredMarkers(body: Record<string, unknown>, enabled: boolean) {
  let restoredMarkers = 0
  let droppedMarkers = 0
  if (!Array.isArray(body.messages)) return { restoredMarkers, droppedMarkers }

  for (const rawMessage of body.messages) {
    if (
      !isRecord(rawMessage) ||
      rawMessage.role !== 'assistant' ||
      !Array.isArray(rawMessage.content)
    ) {
      continue
    }

    const content = rawMessage.content as unknown[]
    const rewritten: unknown[] = []
    let messageRestored = 0
    let messageDropped = 0
    for (const rawBlock of content) {
      const block = isRecord(rawBlock) ? rawBlock : undefined
      const isMarker =
        block?.type === 'thinking' &&
        block.thinking === MARKER_TEXT &&
        typeof block.signature === 'string' &&
        block.signature.startsWith(SIGNATURE_PREFIX)
      if (!isMarker) {
        rewritten.push(rawBlock)
        continue
      }

      const marker = decodeMarkerSignature(block.signature)
      if (enabled && marker) {
        messageRestored++
        rewritten.push(fallbackBlock(marker))
        continue
      }
      messageDropped++
    }

    // Dropping every block would leave an empty content array, which
    // Anthropic rejects — leave the message untouched instead.
    if (rewritten.length === 0 && content.length > 0) continue

    restoredMarkers += messageRestored
    droppedMarkers += messageDropped
    rawMessage.content = rewritten
  }

  return { restoredMarkers, droppedMarkers }
}

/**
 * Opts eligible Fable 5/Opus 5 requests into `fallbacks: "default"` and
 * restores any hidden fallback-boundary markers left by a previous response.
 */
export function applyServerSideFallbackToBody(body: Record<string, unknown>): {
  enabled: boolean
  restoredMarkers: number
  droppedMarkers: number
} {
  const enabled = isRecoverableRefusalModel(body.model)
  const markerResult = rewriteStoredMarkers(body, enabled)
  if (enabled) {
    body.fallbacks = 'default'
  } else if (body.fallbacks === 'default') {
    delete body.fallbacks
  }
  return { enabled, ...markerResult }
}

function findSseBoundary(value: string) {
  const lf = value.indexOf('\n\n')
  const crlf = value.indexOf('\r\n\r\n')
  if (lf === -1) return crlf === -1 ? null : { index: crlf, length: 4 }
  if (crlf === -1 || lf < crlf) return { index: lf, length: 2 }
  return { index: crlf, length: 4 }
}

function parseSseEvent(rawEvent: string): {
  event?: string
  data?: Record<string, unknown>
} {
  let event: string | undefined
  const dataLines: string[] = []
  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      const value = line.slice('data:'.length)
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
    }
  }
  const text = dataLines.join('\n')
  if (!text || text === '[DONE]') return { event }
  try {
    const parsed = JSON.parse(text)
    return { event, data: isRecord(parsed) ? parsed : undefined }
  } catch {
    return { event }
  }
}

function sseFrame(event: string, data: Record<string, unknown>) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function hiddenMarkerFrames(index: number, marker: FallbackMarker) {
  return (
    sseFrame('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'thinking', thinking: MARKER_TEXT },
    }) +
    sseFrame('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: {
        type: 'signature_delta',
        signature: encodeMarkerSignature(marker),
      },
    })
  )
}

/**
 * Streaming SSE rewriter: converts a returned `fallback` content block into
 * a hidden signed `thinking` marker, so OpenCode can store and later replay
 * a response that crossed a server-side fallback boundary.
 */
export function createServerSideFallbackStreamRewriter() {
  let pending = ''

  const rewriteEvent = (rawEvent: string, boundary: string) => {
    const parsed = parseSseEvent(rawEvent)
    const data = parsed.data
    const type = stringField(data, 'type') ?? parsed.event
    if (type === 'content_block_start') {
      const block = isRecord(data?.content_block)
        ? data.content_block
        : undefined
      const marker = block ? markerFromFallbackBlock(block) : null
      if (marker) {
        const index = typeof data?.index === 'number' ? data.index : 0
        return hiddenMarkerFrames(index, marker)
      }
    }
    return rawEvent + boundary
  }

  const drain = () => {
    let output = ''
    while (true) {
      const boundary = findSseBoundary(pending)
      if (!boundary) break
      const rawEvent = pending.slice(0, boundary.index)
      const delimiter = pending.slice(
        boundary.index,
        boundary.index + boundary.length,
      )
      pending = pending.slice(boundary.index + boundary.length)
      output += rewriteEvent(rawEvent, delimiter)
    }
    return output
  }

  return {
    push(text: string) {
      pending += text
      return drain()
    },
    flush() {
      const output = drain()
      if (!pending) return output
      const tail = rewriteEvent(pending, '')
      pending = ''
      return output + tail
    },
  }
}
