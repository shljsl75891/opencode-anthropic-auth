import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from '@opencode-ai/plugin/tui'
import {
  type Accessor,
  createEffect,
  createSignal,
  onCleanup,
  Show,
} from 'solid-js'
import { formatQuotaWindowLine } from './quota-format.ts'
import type { QuotaSnapshot, QuotaWindow } from './quota-headers.ts'
import { readQuotaState } from './quota-state.ts'

// Above the internal sidebar sections (mcp/todo/etc. use order 100-500) —
// quota is meant to stay in peripheral vision at all times.
const SIDEBAR_ORDER = 50
const POLL_MS = 5_000

function QuotaSidebar(props: { api: TuiPluginApi }) {
  const [snapshot, setSnapshot] = createSignal<QuotaSnapshot | undefined>(
    readQuotaState(),
  )

  function refresh() {
    const next = readQuotaState()
    if (next?.checkedAt !== snapshot()?.checkedAt) setSnapshot(next)
  }

  createEffect(() => {
    const timer = setInterval(refresh, POLL_MS)
    onCleanup(() => clearInterval(timer))
  })

  const offMessage = props.api.event.on('message.updated', refresh)
  const offSession = props.api.event.on('session.updated', refresh)
  onCleanup(() => {
    offMessage()
    offSession()
  })

  return (
    <Show when={snapshot()}>
      {(quota: Accessor<QuotaSnapshot>) => (
        <box flexDirection='column'>
          <text>Claude quota</text>
          <Show when={quota().fiveHour}>
            {(window: Accessor<QuotaWindow>) => (
              <text>{formatQuotaWindowLine('5h', window())}</text>
            )}
          </Show>
          <Show when={quota().sevenDay}>
            {(window: Accessor<QuotaWindow>) => (
              <text>{formatQuotaWindowLine('7d', window())}</text>
            )}
          </Show>
          <Show when={quota().fallbackAdvised}>
            <text>fallback advised</text>
          </Show>
        </box>
      )}
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: SIDEBAR_ORDER,
    slots: {
      sidebar_content() {
        return <QuotaSidebar api={api} />
      },
    },
  })
}

const plugin: TuiPluginModule = { tui }
export default plugin
