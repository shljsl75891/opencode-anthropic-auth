import { describe, expect, test } from 'bun:test'
import { parseQuotaHeaders } from '../quota-headers'

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries)
}

describe('parseQuotaHeaders', () => {
  test('parses 5h and 7d windows with reset times', () => {
    const snapshot = parseQuotaHeaders(
      headers({
        'anthropic-ratelimit-unified-5h-utilization': '0.42',
        'anthropic-ratelimit-unified-5h-reset': '1893456000',
        'anthropic-ratelimit-unified-7d-utilization': '0.9',
        'anthropic-ratelimit-unified-7d-reset': '1893542400',
      }),
      new Date('2026-09-04T00:00:00.000Z'),
    )

    expect(snapshot).toEqual({
      fiveHour: {
        usedPercent: 42,
        remainingPercent: 58,
        resetsAt: new Date(1893456000 * 1000).toISOString(),
      },
      sevenDay: {
        usedPercent: 90,
        remainingPercent: 10,
        resetsAt: new Date(1893542400 * 1000).toISOString(),
      },
      fallbackAdvised: false,
      bindingWindow: undefined,
      checkedAt: '2026-09-04T00:00:00.000Z',
    })
  })

  test('returns undefined when no quota headers are present', () => {
    expect(parseQuotaHeaders(headers({}))).toBeUndefined()
  })

  test('captures fallback availability and binding window', () => {
    const snapshot = parseQuotaHeaders(
      headers({
        'anthropic-ratelimit-unified-5h-utilization': '0.1',
        'anthropic-ratelimit-unified-5h-reset': '1893456000',
        'anthropic-ratelimit-unified-fallback': 'available',
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      }),
    )

    expect(snapshot?.fallbackAdvised).toBe(true)
    expect(snapshot?.bindingWindow).toBe('five_hour')
  })

  test('rounds and clamps utilization to 0-100', () => {
    const snapshot = parseQuotaHeaders(
      headers({
        'anthropic-ratelimit-unified-5h-utilization': '1.4',
        'anthropic-ratelimit-unified-5h-reset': '1893456000',
      }),
    )

    expect(snapshot?.fiveHour?.usedPercent).toBe(100)
    expect(snapshot?.fiveHour?.remainingPercent).toBe(0)
  })

  test('rounds up on any fractional utilization, matching Anthropic\u2019s usage UI', () => {
    const snapshot = parseQuotaHeaders(
      headers({
        'anthropic-ratelimit-unified-7d-utilization': '0.081',
        'anthropic-ratelimit-unified-7d-reset': '1893456000',
      }),
    )

    // Math.round(8.1) would give 8; the observed UI shows 9 here.
    expect(snapshot?.sevenDay?.usedPercent).toBe(9)
  })

  test('keeps exact zero utilization at 0%', () => {
    const snapshot = parseQuotaHeaders(
      headers({
        'anthropic-ratelimit-unified-7d-utilization': '0',
        'anthropic-ratelimit-unified-7d-reset': '1893456000',
      }),
    )

    expect(snapshot?.sevenDay?.usedPercent).toBe(0)
  })

  test('omits a window whose reset is finite but not a representable date', () => {
    const snapshot = parseQuotaHeaders(
      headers({
        'anthropic-ratelimit-unified-5h-utilization': '0.5',
        'anthropic-ratelimit-unified-5h-reset': '1e308',
        'anthropic-ratelimit-unified-7d-utilization': '0.2',
        'anthropic-ratelimit-unified-7d-reset': '1893456000',
      }),
    )

    expect(snapshot?.fiveHour).toBeUndefined()
    expect(snapshot?.sevenDay?.usedPercent).toBe(20)
  })

  test('omits a window whose utilization is not a valid number', () => {
    const snapshot = parseQuotaHeaders(
      headers({
        'anthropic-ratelimit-unified-5h-utilization': 'not-a-number',
        'anthropic-ratelimit-unified-7d-utilization': '0.2',
        'anthropic-ratelimit-unified-7d-reset': '1893456000',
      }),
    )

    expect(snapshot?.fiveHour).toBeUndefined()
    expect(snapshot?.sevenDay?.usedPercent).toBe(20)
  })
})
