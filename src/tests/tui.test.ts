import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RGBA } from '@opentui/core'
import { testRender } from '@opentui/solid'
import type { QuotaSnapshot } from '../quota-headers.ts'
import { writeQuotaState } from '../quota-state.ts'
import plugin from '../tui.tsx'

describe('tui plugin module', () => {
  test('exports a setup function', () => {
    expect(plugin.setup).toBeFunction()
  })

  test('exports a non-empty id for path-referenced plugin loading', () => {
    expect(typeof plugin.id).toBe('string')
    expect(plugin.id.length).toBeGreaterThan(0)
  })
})

const color = RGBA.fromHex('#ffffff')
const feedback = { default: color, subdued: color }

function snapshot(usedPercent: number, checkedAt: string): QuotaSnapshot {
  return {
    fiveHour: {
      usedPercent,
      remainingPercent: 100 - usedPercent,
      resetsAt: '2026-09-04T05:00:00.000Z',
    },
    sevenDay: {
      usedPercent: 11,
      remainingPercent: 89,
      resetsAt: '2026-09-09T00:00:00.000Z',
    },
    fallbackAdvised: false,
    bindingWindow: undefined,
    checkedAt,
  }
}

function fakeContext() {
  const handlers = new Map<string, () => void>()
  let claim: { render: (input: { sessionID: string }) => unknown } | undefined
  const context = {
    theme: {
      text: {
        default: color,
        subdued: color,
        feedback: { error: feedback, warning: feedback, success: feedback },
      },
    },
    data: {
      on(type: string, handler: () => void) {
        handlers.set(type, handler)
        return () => handlers.delete(type)
      },
    },
    ui: {
      slot(input: {
        render: (input: { sessionID: string }) => unknown
        append: string
      }) {
        claim = input
        return () => {
          claim = undefined
        }
      },
    },
  } as unknown as import('@opencode/plugin/tui/context').Context
  return {
    context,
    emit(type: string) {
      const handler = handlers.get(type)
      expect(handler).toBeDefined()
      handler?.()
    },
    sidebar() {
      expect(claim).toBeDefined()
      return claim?.render({ sessionID: 'session' })
    },
  }
}

// The host compiles npm-installed plugins with Bun's native JSX (no Solid
// babel transform), so these tests must run tui.tsx the same way: no preload.
describe('quota sidebar', () => {
  let dir: string
  const originalFile = process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FILE

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tui-test-'))
    process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FILE = join(dir, 'quota.json')
    setSystemTime(new Date('2026-09-04T00:00:00.000Z'))
  })

  afterEach(() => {
    setSystemTime()
    if (originalFile === undefined)
      delete process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FILE
    else process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FILE = originalFile
    rmSync(dir, { recursive: true, force: true })
  })

  test('re-renders usage and countdown when a request updates the quota file', async () => {
    writeQuotaState(snapshot(4, '2026-09-04T00:00:00.000Z'))
    const { context, emit, sidebar } = fakeContext()
    plugin.setup(context)

    const { renderer, renderOnce, captureCharFrame } = await testRender(
      () => sidebar(),
      { width: 60, height: 8 },
    )
    try {
      await renderOnce()
      expect(captureCharFrame()).toContain('5h ')
      expect(captureCharFrame()).toContain('4% · resets in 5h')
      expect(captureCharFrame()).toContain('11% · resets in 5d')

      writeQuotaState(snapshot(42, '2026-09-04T03:00:00.000Z'))
      setSystemTime(new Date('2026-09-04T03:00:00.000Z'))
      emit('session.usage.updated')
      await renderOnce()
      expect(captureCharFrame()).toContain('42% · resets in 2h')
      expect(captureCharFrame()).not.toContain('4% · resets in 5h')
    } finally {
      renderer.destroy()
    }
  })

  test('renders nothing until a quota snapshot exists', async () => {
    const { context, sidebar } = fakeContext()
    plugin.setup(context)

    const { renderer, renderOnce, captureCharFrame } = await testRender(
      () => sidebar(),
      { width: 60, height: 8 },
    )
    try {
      await renderOnce()
      expect(captureCharFrame()).not.toContain('Claude quota')
    } finally {
      renderer.destroy()
    }
  })
})
