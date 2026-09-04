import {
  fg as styledFg,
  StyledText,
  type TextRenderable,
} from '@opentui/core'
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiThemeCurrent,
} from '@opencode-ai/plugin/tui'
import {
  type Accessor,
  createEffect,
  createSignal,
  onCleanup,
  Show,
} from 'solid-js'
import { formatQuotaWindowParts, type QuotaTone } from './quota-format.ts'
import type { QuotaSnapshot, QuotaWindow } from './quota-headers.ts'
import { readQuotaState } from './quota-state.ts'

// Above the internal sidebar sections (mcp/todo/etc. use order 100-500) —
// quota is meant to stay in peripheral vision at all times.
const SIDEBAR_ORDER = 50
const POLL_MS = 5_000

function toneColor(theme: TuiThemeCurrent, tone: QuotaTone) {
  if (tone === 'err') return theme.error
  if (tone === 'warn') return theme.warning
  return theme.success
}

function QuotaWindowRow(props: {
  theme: TuiThemeCurrent
  label: string
  window: QuotaWindow
}) {
  // The Solid reconciler stringifies the "content" JSX prop (`${value}`)
  // instead of forwarding it, so a StyledText assigned that way renders as
  // "[object Object]". Set node.content directly via ref instead.
  let node: TextRenderable | undefined
  createEffect(() => {
    const parts = formatQuotaWindowParts(props.label, props.window)
    const styled = new StyledText([
      styledFg(props.theme.textMuted)(`${parts.label} `),
      styledFg(toneColor(props.theme, parts.tone))(parts.bar),
      styledFg(props.theme.textMuted)(` ${parts.suffix}`),
    ])
    if (node) node.content = styled
  })
  return (
    <text
      ref={(el) => {
        node = el
      }}
    />
  )
}

function QuotaSidebar(props: { api: TuiPluginApi }) {
  const [snapshot, setSnapshot] = createSignal<QuotaSnapshot | undefined>(
    readQuotaState(),
  )
  const theme = () => props.api.theme.current

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
        <box flexDirection='column' gap={1}>
          <text fg={theme().text}>
            <b>Claude quota</b>
          </text>
          <Show when={quota().fiveHour}>
            {(window: Accessor<QuotaWindow>) => (
              <QuotaWindowRow theme={theme()} label='5h' window={window()} />
            )}
          </Show>
          <Show when={quota().sevenDay}>
            {(window: Accessor<QuotaWindow>) => (
              <QuotaWindowRow theme={theme()} label='7d' window={window()} />
            )}
          </Show>
          <Show when={quota().fallbackAdvised}>
            <text fg={theme().warning}>fallback advised</text>
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

// Path-referenced plugins (config `plugin: ["/abs/path"]`) require an
// exported id; the host throws "Path plugin must export id" without it.
const plugin: TuiPluginModule & { id: string } = {
  id: '@sahiljassal/opencode-anthropic-auth',
  tui,
}
export default plugin
