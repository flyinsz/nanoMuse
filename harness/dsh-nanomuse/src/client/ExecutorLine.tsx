/**
 * The line above the composer saying which device runs this conversation (contract C13).
 *
 * The design asks for it plainly: the interface must always say whose memory the next sentence
 * will use, because `@Desk` moves the owner and there is otherwise nothing on screen that
 * changed. A person who typed `@Desk` an hour ago and forgot should not have to guess whether
 * the sentence they are about to send lands here or on the desk machine.
 *
 * It reads the same resolution the routing does (`session-owner.ts`'s `executorOf`, through
 * `currentExecutor`), so the line and the destination cannot drift apart. A device that went
 * offline is still named, with the send's own refusal in the wording: that is the state the
 * person most needs to see before typing, not after.
 *
 * Drawn as one quiet line in the composer's dock, beside the device's own progress line
 * (`device-task.ts`), in that line's shape. Hidden on an account with one device, where it would
 * read "Run by this computer" in every chat and say nothing; `executorVisible` owns that call.
 */
import { createElement as h, type ReactNode } from 'react'
import { type Translate } from './api.ts'
import { currentExecutor, setCurrentSession } from './device-task.ts'
import { useOwner } from './owner-store.ts'
import { executorVisible, type OwnerTarget } from './session-owner.ts'
import { IconLaptop, IconPhone } from './icons.tsx'
import { useLive, type LiveDevice } from './live.ts'

/**
 * The line, in the UI language.
 *
 * Exported so it can be worded without a renderer, the way the row's rules are: which of the
 * three sentences is used, and with which name, is the whole of the decision.
 */
export function executorText(t: Translate, target: OwnerTarget, fallback: string): string {
  if (target.kind === 'local') return t('exSelf')
  const device = target.name.trim() || fallback
  return target.online ? t('exRuns', { device }) : t('exOffline', { device })
}

/** The device's own icon, so the line reads at a glance without its words. */
function deviceIcon(devices: readonly LiveDevice[], id: string): (p: { size?: number }) => ReactNode {
  return devices.find((d) => d.id === id)?.kind === 'phone' ? IconPhone : IconLaptop
}

export function makeExecutorLine(t: Translate) {
  return function ExecutorLine(props?: { sessionId?: string | undefined } | undefined): ReactNode {
    // The dock is a session-scope seat: it *is* the conversation, so it hands the id down and
    // `currentExecutor` can answer for this chat rather than for whatever was open before.
    if (props?.sessionId) setCurrentSession(props.sessionId)
    const live = useLive()
    // Re-read when the owner is written (`@Desk`, `@本机`), so the line follows the mention at the
    // moment it is sent rather than on the next hub frame.
    useOwner(props?.sessionId)
    const target = currentExecutor()
    if (!executorVisible(target, live.hub.devices, live.hub.deviceId)) return null
    const label = executorText(t, target, t('otherDevice'))
    const Icon = target.kind === 'device' ? deviceIcon(live.hub.devices, target.id) : IconLaptop
    return h('div', {
      className: `nm-ex-line${target.kind === 'local' ? ' nm-ex-self' : ''}${target.kind === 'device' && !target.online ? ' nm-ex-off' : ''}`,
      role: 'status',
      'data-testid': 'nm-ex-line',
      title: label,
    },
      h(Icon, { size: 13 }),
      h('span', { className: 'nm-ex-line-text' }, label))
  }
}
