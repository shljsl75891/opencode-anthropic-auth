/**
 * Anthropic returns cumulative 5h/7d quota utilization on every
 * /v1/messages response — no separate usage-endpoint call needed.
 */
const PREFIX = 'anthropic-ratelimit-unified-'

export interface QuotaWindow {
  usedPercent: number
  remainingPercent: number
  resetsAt: string
}

export interface QuotaSnapshot {
  fiveHour?: QuotaWindow
  sevenDay?: QuotaWindow
  fallbackAdvised: boolean
  bindingWindow?: string
  checkedAt: string
}

function parseWindow(
  headers: Headers,
  window: '5h' | '7d',
): QuotaWindow | undefined {
  const utilizationRaw = headers.get(`${PREFIX}${window}-utilization`)
  const resetRaw = headers.get(`${PREFIX}${window}-reset`)
  if (utilizationRaw === null || resetRaw === null) return undefined

  const utilization = Number(utilizationRaw)
  const reset = Number(resetRaw)
  if (!Number.isFinite(utilization) || !Number.isFinite(reset)) return undefined

  // A finite epoch can still exceed the range Date can represent.
  const resetsAt = new Date(reset * 1000)
  if (Number.isNaN(resetsAt.getTime())) return undefined

  // Anthropic's own usage UI rounds up (0.081 -> 9%, not 8%) — ceiling
  // keeps a usage meter conservative and matches what users see there.
  const usedPercent = Math.min(100, Math.max(0, Math.ceil(utilization * 100)))
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt: resetsAt.toISOString(),
  }
}

export function parseQuotaHeaders(
  headers: Headers,
  now: Date = new Date(),
): QuotaSnapshot | undefined {
  const fiveHour = parseWindow(headers, '5h')
  const sevenDay = parseWindow(headers, '7d')
  if (!fiveHour && !sevenDay) return undefined

  return {
    fiveHour,
    sevenDay,
    fallbackAdvised: headers.get(`${PREFIX}fallback`) === 'available',
    bindingWindow: headers.get(`${PREFIX}representative-claim`) ?? undefined,
    checkedAt: now.toISOString(),
  }
}
