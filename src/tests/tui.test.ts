import { describe, expect, test } from 'bun:test'
import plugin from '../tui.tsx'

describe('tui plugin module', () => {
  test('exports a tui entrypoint function and no server hooks', () => {
    expect(plugin.tui).toBeFunction()
    expect(plugin.server).toBeUndefined()
  })
})
