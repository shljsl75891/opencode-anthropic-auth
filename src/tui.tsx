/** @jsxImportSource @opentui/solid */
import { Plugin } from '@opencode/plugin/tui'
import type { Context } from '@opencode/plugin/tui/context'
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

const POLL_MS = 5_000

function toneColor(theme: Context['theme'], tone: QuotaTone) {
  if (tone === 'err') return theme.text.feedback.error.default
  if (tone === 'warn') return theme.text.feedback.warning.default
  return theme.text.feedback.success.default
}

// This plugin loads from node_modules, which OpenCode's Solid JSX transform
// deliberately skips (see opencode#33884). Without that transform, JSX props
// are evaluated once instead of compiled into reactive getters, so anything
// built with createSignal/createEffect/Show only ever renders its first
// value. Updates are driven imperatively instead: refs are captured once,
// then a timer writes straight to node.content/node.visible.
function QuotaSidebar(props: { context: Context }) {
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
      <text fg={props.context.theme.text.default}>
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
    const theme = props.context.theme
    const parts = formatQuotaWindowParts(label, window, now)
    node.content = new StyledText([
      styledFg(theme.text.subdued)(`${parts.label} `),
      styledFg(toneColor(theme, parts.tone))(parts.bar),
      styledFg(theme.text.subdued)(` ${parts.suffix}`),
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
  const offUsage = props.context.data.on('session.usage.updated', paint)
  const offStatus = props.context.data.on('session.status', paint)
  onCleanup(() => {
    clearInterval(timer)
    offUsage()
    offStatus()
  })

  return element
}

export default Plugin.define({
  id: '@sahiljassal/opencode-anthropic-auth',
  setup(context) {
    return context.ui.slot({
      append: 'sidebar.content',
      render: () => <QuotaSidebar context={context} />,
    })
  },
})
