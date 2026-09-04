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

export function formatQuotaWindowLine(
  label: string,
  window: QuotaWindow,
  now: Date = new Date(),
): string {
  return `${label}: ${window.usedPercent}% used · resets ${formatRelativeTime(window.resetsAt, now)}`
}
