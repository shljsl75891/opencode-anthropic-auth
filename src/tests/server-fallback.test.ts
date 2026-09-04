import { describe, expect, test } from 'bun:test'
import {
  applyServerSideFallbackToBody,
  createServerSideFallbackStreamRewriter,
  isRecoverableRefusalModel,
} from '../server-fallback'
import type { RetryableAnthropicStreamError } from '../stream-error'

describe('isRecoverableRefusalModel', () => {
  test('matches Fable 5 and Opus 5, including dated variants', () => {
    expect(isRecoverableRefusalModel('claude-fable-5')).toBe(true)
    expect(isRecoverableRefusalModel('claude-opus-5')).toBe(true)
    expect(isRecoverableRefusalModel('claude-opus-5-20260101')).toBe(true)
  })

  test('rejects other models', () => {
    expect(isRecoverableRefusalModel('claude-sonnet-5')).toBe(false)
    expect(isRecoverableRefusalModel('claude-opus-4-8')).toBe(false)
    expect(isRecoverableRefusalModel(undefined)).toBe(false)
  })
})

describe('applyServerSideFallbackToBody', () => {
  test('opts an eligible model into fallbacks: default', () => {
    const body: Record<string, unknown> = {
      model: 'claude-fable-5',
      messages: [],
    }
    const result = applyServerSideFallbackToBody(body)
    expect(result).toEqual({
      enabled: true,
      restoredMarkers: 0,
      droppedMarkers: 0,
    })
    expect(body.fallbacks).toBe('default')
  })

  test('does not opt an ineligible model in, and strips a stale field', () => {
    const body = {
      model: 'claude-sonnet-5',
      messages: [],
      fallbacks: 'default',
    }
    const result = applyServerSideFallbackToBody(body)
    expect(result.enabled).toBe(false)
    expect(body.fallbacks).toBeUndefined()
  })

  test('restores a hidden marker into a fallback block when enabled', () => {
    const body: Record<string, unknown> = {
      model: 'claude-fable-5',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: '\u2060',
              signature:
                'opencode-anthropic-auth-server-fallback-v1:claude-fable-5|claude-opus-5',
            },
            { type: 'text', text: 'hi' },
          ],
        },
      ],
    }
    const result = applyServerSideFallbackToBody(body)
    expect(result.restoredMarkers).toBe(1)
    expect(result.droppedMarkers).toBe(0)
    const messages = body.messages as Array<{ content: unknown[] }>
    expect(messages[0]?.content[0]).toEqual({
      type: 'fallback',
      from: { model: 'claude-fable-5' },
      to: { model: 'claude-opus-5' },
    })
  })

  test('drops a hidden marker without restoring it when not enabled', () => {
    const body: Record<string, unknown> = {
      model: 'claude-sonnet-5',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: '\u2060',
              signature:
                'opencode-anthropic-auth-server-fallback-v1:claude-fable-5|claude-opus-5',
            },
            { type: 'text', text: 'hi' },
          ],
        },
      ],
    }
    const result = applyServerSideFallbackToBody(body)
    expect(result.restoredMarkers).toBe(0)
    expect(result.droppedMarkers).toBe(1)
    const messages = body.messages as Array<{ content: unknown[] }>
    expect(messages[0]?.content).toEqual([{ type: 'text', text: 'hi' }])
  })

  test('leaves the message untouched when dropping the marker would empty its content', () => {
    const body: Record<string, unknown> = {
      model: 'claude-sonnet-5',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: '\u2060',
              signature:
                'opencode-anthropic-auth-server-fallback-v1:claude-fable-5|claude-opus-5',
            },
          ],
        },
      ],
    }
    const result = applyServerSideFallbackToBody(body)
    expect(result.droppedMarkers).toBe(0)
    const messages = body.messages as Array<{ content: unknown[] }>
    expect(messages[0]?.content).toEqual([
      {
        type: 'thinking',
        thinking: '\u2060',
        signature:
          'opencode-anthropic-auth-server-fallback-v1:claude-fable-5|claude-opus-5',
      },
    ])
  })
})

function sseFrame(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
}

describe('createServerSideFallbackStreamRewriter', () => {
  test('passes through events with no fallback block unchanged', () => {
    const rewriter = createServerSideFallbackStreamRewriter()

    const messageStart = sseFrame('message_start', {
      message: { model: 'claude-fable-5', usage: {} },
    })
    const messageDelta = sseFrame('message_delta', {
      delta: { stop_reason: 'end_turn' },
      usage: {},
    })

    let out = rewriter.push(messageStart)
    out += rewriter.push(messageDelta)
    expect(out).toBe(messageStart + messageDelta)
  })

  test('rewrites a mid-output fallback block into a hidden signed marker', () => {
    const rewriter = createServerSideFallbackStreamRewriter()

    const messageStart = sseFrame('message_start', {
      message: { model: 'claude-opus-5', usage: {} },
    })
    const fallbackBlockStart = sseFrame('content_block_start', {
      index: 0,
      content_block: {
        type: 'fallback',
        from: { model: 'claude-fable-5' },
        to: { model: 'claude-opus-5' },
      },
    })
    const messageDelta = sseFrame('message_delta', {
      delta: { stop_reason: 'end_turn' },
      usage: {},
    })

    const out =
      rewriter.push(messageStart) +
      rewriter.push(fallbackBlockStart) +
      rewriter.push(messageDelta)

    expect(out).not.toContain('"type":"fallback"')
    expect(out).toContain('\u2060')
    expect(out).toContain(
      'opencode-anthropic-auth-server-fallback-v1:claude-fable-5|claude-opus-5',
    )
  })

  test('flush() rewrites a final chunk with no trailing boundary', () => {
    const rewriter = createServerSideFallbackStreamRewriter()

    rewriter.push(
      sseFrame('message_start', {
        message: { model: 'claude-fable-5', usage: {} },
      }),
    )
    const finalFrame =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{}}'
    const flushed = rewriter.push(finalFrame) + rewriter.flush()
    expect(flushed).toBe(finalFrame)
  })

  test('rewrites a fallback block delimited by bare CR line endings', () => {
    const rewriter = createServerSideFallbackStreamRewriter()

    const messageStart = sseFrame('message_start', {
      message: { model: 'claude-opus-5', usage: {} },
    })
    const data = JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'fallback',
        from: { model: 'claude-fable-5' },
        to: { model: 'claude-opus-5' },
      },
    })
    const crFallbackBlockStart = `event: content_block_start\rdata: ${data}\r\r`

    const out =
      rewriter.push(messageStart) + rewriter.push(crFallbackBlockStart)

    expect(out).not.toContain('"type":"fallback"')
    expect(out).toContain('\u2060')
    expect(out).toContain(
      'opencode-anthropic-auth-server-fallback-v1:claude-fable-5|claude-opus-5',
    )
  })

  test('rewrites a fallback block whose bare-CR delimiter is split across chunks', () => {
    const rewriter = createServerSideFallbackStreamRewriter()

    const data = JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'fallback',
        from: { model: 'claude-fable-5' },
        to: { model: 'claude-opus-5' },
      },
    })

    // The two CRs of the delimiter land in different network chunks.
    const out =
      rewriter.push(`event: content_block_start\rdata: ${data}\r`) +
      rewriter.push('\r')

    expect(out).not.toContain('"type":"fallback"')
    expect(out).toContain(
      'opencode-anthropic-auth-server-fallback-v1:claude-fable-5|claude-opus-5',
    )
  })

  test('fails retryably on an oversized frame that never reaches a boundary', () => {
    const rewriter = createServerSideFallbackStreamRewriter()

    let caught: unknown
    try {
      rewriter.push('x'.repeat(1_048_577))
    } catch (err) {
      caught = err
    }

    // Forwarding an unterminated buffer as if it were a whole event would
    // leak a half-parsed fallback block; failing retryably is safe instead.
    const err = caught as RetryableAnthropicStreamError
    expect(err?.code).toBe('ECONNRESET')
    expect(err?.syscall).toBe('anthropic-sse')
  })
})
