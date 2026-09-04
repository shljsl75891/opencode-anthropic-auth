import type { QuotaWindow } from './quota-headers.ts'

export function formatRelativeTime(
  iso: string,
  now: Date = new Date(),
): string {
  const ms = new Date(iso).getTime() - now.getTime()
  if (!Number.isFinite(ms) || ms <= 0) return 'soon'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `in ${hours}h`
  const days = Math.round(hours / 24)
  return `in ${days}d`
}

const BAR_WIDTH = 10
const BAR_FILLED = '█'
const BAR_EMPTY = '░'

export function renderQuotaBar(
  usedPercent: number,
  width: number = BAR_WIDTH,
): string {
  const clamped = Math.min(100, Math.max(0, usedPercent))
  const filled = Math.round((clamped / 100) * width)
  return BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(width - filled)
}

export type QuotaTone = 'ok' | 'warn' | 'err'

export function quotaTone(usedPercent: number): QuotaTone {
  if (usedPercent >= 90) return 'err'
  if (usedPercent >= 75) return 'warn'
  return 'ok'
}

export interface QuotaWindowParts {
  label: string
  bar: string
  tone: QuotaTone
  suffix: string
}

export function formatQuotaWindowParts(
  label: string,
  window: QuotaWindow,
  now: Date = new Date(),
): QuotaWindowParts {
  return {
    label,
    bar: renderQuotaBar(window.usedPercent),
    tone: quotaTone(window.usedPercent),
    suffix: `${window.usedPercent}% · resets ${formatRelativeTime(window.resetsAt, now)}`,
  }
}
