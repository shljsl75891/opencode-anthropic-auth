import { describe, expect, test } from 'bun:test'
import plugin from '../tui.tsx'

describe('tui plugin module', () => {
  test('exports a tui entrypoint function and no server hooks', () => {
    expect(plugin.tui).toBeFunction()
    expect(plugin.server).toBeUndefined()
  })

  test('exports a non-empty id for path-referenced plugin loading', () => {
    expect(typeof plugin.id).toBe('string')
    expect(plugin.id.length).toBeGreaterThan(0)
  })
})
