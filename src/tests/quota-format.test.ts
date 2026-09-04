import { describe, expect, test } from 'bun:test'
import {
  formatQuotaWindowParts,
  formatRelativeTime,
  quotaTone,
  renderQuotaBar,
} from '../quota-format'

describe('formatRelativeTime', () => {
  const now = new Date('2026-09-04T00:00:00.000Z')

  test('formats minutes for under an hour', () => {
    expect(formatRelativeTime('2026-09-04T00:30:00.000Z', now)).toBe('in 30m')
  })

  test('formats hours for under a day', () => {
    expect(formatRelativeTime('2026-09-04T05:00:00.000Z', now)).toBe('in 5h')
  })

  test('formats days for a day or more', () => {
    expect(formatRelativeTime('2026-09-11T00:00:00.000Z', now)).toBe('in 7d')
  })

  test('returns "soon" for a time at or before now', () => {
    expect(formatRelativeTime('2026-09-03T00:00:00.000Z', now)).toBe('soon')
  })
})

describe('renderQuotaBar', () => {
  test('renders an empty bar at 0%', () => {
    expect(renderQuotaBar(0)).toBe('░░░░░░░░░░')
  })

  test('renders a full bar at 100%', () => {
    expect(renderQuotaBar(100)).toBe('██████████')
  })

  test('rounds to the nearest filled segment', () => {
    expect(renderQuotaBar(15)).toBe('██░░░░░░░░')
    expect(renderQuotaBar(50)).toBe('█████░░░░░')
  })

  test('clamps out-of-range percentages', () => {
    expect(renderQuotaBar(-10)).toBe('░░░░░░░░░░')
    expect(renderQuotaBar(150)).toBe('██████████')
  })
})

describe('quotaTone', () => {
  test('is "ok" below 75%', () => {
    expect(quotaTone(0)).toBe('ok')
    expect(quotaTone(74)).toBe('ok')
  })

  test('is "warn" from 75% to 89%', () => {
    expect(quotaTone(75)).toBe('warn')
    expect(quotaTone(89)).toBe('warn')
  })

  test('is "err" from 90% up', () => {
    expect(quotaTone(90)).toBe('err')
    expect(quotaTone(100)).toBe('err')
  })
})

describe('formatQuotaWindowParts', () => {
  test('combines label, bar, tone, and reset suffix', () => {
    const now = new Date('2026-09-04T00:00:00.000Z')
    const parts = formatQuotaWindowParts(
      '5h',
      {
        usedPercent: 42,
        remainingPercent: 58,
        resetsAt: '2026-09-04T05:00:00.000Z',
      },
      now,
    )
    expect(parts).toEqual({
      label: '5h',
      bar: '████░░░░░░',
      tone: 'ok',
      suffix: '42% · resets in 5h',
    })
  })
})
