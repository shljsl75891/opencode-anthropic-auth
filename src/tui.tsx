/** @jsxImportSource @opentui/solid */
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiThemeCurrent,
} from '@opencode-ai/plugin/tui'
import {
  type BoxRenderable,
  StyledText,
  fg as styledFg,
  type TextRenderable,
} from '@opentui/core'
import { onCleanup } from 'solid-js'
import { formatQuotaWindowParts, type QuotaTone } from './quota-format.ts'
import type { QuotaWindow } from './quota-headers.ts'
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

// This plugin loads from node_modules, which OpenCode's Solid JSX transform
// deliberately skips (see opencode#33884). Without that transform, JSX props
// are evaluated once instead of compiled into reactive getters, so anything
// built with createSignal/createEffect/Show only ever renders its first
// value. Updates are driven imperatively instead: refs are captured once,
// then a timer writes straight to node.content/node.visible.
function QuotaSidebar(props: { api: TuiPluginApi }) {
  let box: BoxRenderable | undefined
  let fiveHourRow: TextRenderable | undefined
  let sevenDayRow: TextRenderable | undefined

  const element = (
    <box
      ref={(el) => {
        box = el
      }}
      flexDirection='column'
      gap={1}
      visible={false}
    >
      <text fg={props.api.theme.current.text}>
        <b>Claude quota</b>
      </text>
      <text
        ref={(el) => {
          fiveHourRow = el
        }}
      />
      <text
        ref={(el) => {
          sevenDayRow = el
        }}
      />
    </box>
  )

  function paintRow(
    node: TextRenderable | undefined,
    label: string,
    window: QuotaWindow | undefined,
    now: Date,
  ) {
    if (!node) return
    if (!window) {
      node.visible = false
      return
    }
    const theme = props.api.theme.current
    const parts = formatQuotaWindowParts(label, window, now)
    node.content = new StyledText([
      styledFg(theme.textMuted)(`${parts.label} `),
      styledFg(toneColor(theme, parts.tone))(parts.bar),
      styledFg(theme.textMuted)(` ${parts.suffix}`),
    ])
    node.visible = true
  }

  function paint() {
    const snapshot = readQuotaState()
    if (!box) return
    if (!snapshot) {
      box.visible = false
      return
    }
    box.visible = true
    const now = new Date()
    paintRow(fiveHourRow, '5h', snapshot.fiveHour, now)
    paintRow(sevenDayRow, '7d', snapshot.sevenDay, now)
  }

  paint()
  const timer = setInterval(paint, POLL_MS)
  const offMessage = props.api.event.on('message.updated', paint)
  const offSession = props.api.event.on('session.updated', paint)
  onCleanup(() => {
    clearInterval(timer)
    offMessage()
    offSession()
  })

  return element
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
