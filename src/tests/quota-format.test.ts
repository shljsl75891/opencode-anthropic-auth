import { describe, expect, test } from 'bun:test'
import { formatQuotaWindowLine, formatRelativeTime } from '../quota-format'

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

describe('formatQuotaWindowLine', () => {
  test('combines label, percent, and reset countdown', () => {
    const now = new Date('2026-09-04T00:00:00.000Z')
    const line = formatQuotaWindowLine(
      '5h',
      {
        usedPercent: 42,
        remainingPercent: 58,
        resetsAt: '2026-09-04T05:00:00.000Z',
      },
      now,
    )
    expect(line).toBe('5h: 42% used · resets in 5h')
  })
})
