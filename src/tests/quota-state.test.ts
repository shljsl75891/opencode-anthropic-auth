import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QuotaSnapshot } from '../quota-headers'
import {
  getQuotaStateFile,
  readQuotaState,
  writeQuotaState,
} from '../quota-state'

const snapshot: QuotaSnapshot = {
  fiveHour: {
    usedPercent: 42,
    remainingPercent: 58,
    resetsAt: '2026-09-04T05:00:00.000Z',
  },
  sevenDay: {
    usedPercent: 10,
    remainingPercent: 90,
    resetsAt: '2026-09-11T00:00:00.000Z',
  },
  fallbackAdvised: false,
  bindingWindow: undefined,
  checkedAt: '2026-09-04T00:00:00.000Z',
}

describe('quota-state', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'quota-state-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('writes then reads back an equivalent snapshot', () => {
    const file = join(dir, 'quota.json')
    writeQuotaState(snapshot, file)
    expect(readQuotaState(file)).toEqual(snapshot)
  })

  test('creates the parent directory if missing', () => {
    const file = join(dir, 'nested', 'quota.json')
    writeQuotaState(snapshot, file)
    expect(readQuotaState(file)).toEqual(snapshot)
  })

  test('returns undefined when the file does not exist', () => {
    expect(readQuotaState(join(dir, 'missing.json'))).toBeUndefined()
  })

  test('returns undefined for malformed JSON', () => {
    const file = join(dir, 'quota.json')
    writeFileSync(file, '{not json')
    expect(readQuotaState(file)).toBeUndefined()
  })

  test('getQuotaStateFile respects the env override', () => {
    const original = process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FILE
    process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FILE = '/tmp/custom-quota.json'
    try {
      expect(getQuotaStateFile()).toBe('/tmp/custom-quota.json')
    } finally {
      if (original === undefined)
        delete process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FILE
      else process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FILE = original
    }
  })
})
