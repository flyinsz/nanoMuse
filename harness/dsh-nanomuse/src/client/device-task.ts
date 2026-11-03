/**
 * A message addressed to another device of the account, typed at this computer's composer
 * (`@<device> …`). The turn runs on that device's own Muse and its answer comes back here,
 * with no turn of this computer's model in between.
 *
 * Without this the mention reaches this computer's Muse as an ordinary message and the model
 * has to relay it with `delegate`: a whole turn spent on a frame that could have been built
 * directly, and a place where the model can reword what was asked or do the work itself.
 *
 * The reading of the mention is `device-mention.ts` (the rules of `nanomuse/sync/mention.py`);
 * the frame is built by the host half, which is the side that holds the hub socket
 * (`devices/ask`).
 *
 * `deviceTask` is the small state machine the composer drives and the card renders, the same
 * shape `avatarChat` uses: `useSyncExternalStore` over a module-level snapshot.
 */
import { createElement as h, useSyncExternalStore, type ReactNode } from 'react'
import { call, failureText, type Translate } from './api.ts'
import { deviceMention } from './device-mention.ts'
import { IconClose, IconSpinner } from './icons.tsx'
import { peekLive, type LiveDevice } from './live.ts'

/** The answer to one `@<device>` message, as the host half reports it. */
export interface DeviceAnswer {
  device: string
  answer: string
  /** What the run did along the way: one line per step. */
  steps: string[]
}

/**
 * Where a device task stands. A question the other device's Muse has to ask does not appear
 * here: it goes up as this computer's own kind of approval card (the host's `RemoteApprovals`),
 * drawn from `live.approvals` and answered through the same route as every other card.
 */
export interface DeviceTaskState {
  phase: 'idle' | 'asking' | 'answered' | 'failed'
  /** The device's name, for the card's title. */
  device: string
  /** What was asked, kept so the card can say it while the run is out. */
  asked: string
  answer: string
  steps: string[]
  /** The failure as it came; the card words it through `failureText`. */
  error?: unknown
}

const IDLE: DeviceTaskState = { phase: 'idle', device: '', asked: '', answer: '', steps: [] }

let state: DeviceTaskState = IDLE
let round = 0
const listeners = new Set<() => void>()

function set(patch: Partial<DeviceTaskState>): void {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

export function useDeviceTask(): DeviceTaskState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
    () => state,
  )
}

/** The devices a message may be addressed to: the ones online, this computer never one of them. */
export function reachableDevices(): LiveDevice[] {
  return peekLive().hub.devices.filter((d) => d.online && d.name.trim().length > 0)
}

/**
 * The device `text` addresses, when it addresses one that is online, with the mention taken
 * out. Null when the message is not one, so the ordinary path keeps it.
 */
export function addressedDevice(text: string): { device: LiveDevice; text: string } | null {
  return deviceMention(text, reachableDevices())
}

/** What a card needs to word itself, in the UI language. */
export function deviceTaskView(t: Translate, s: DeviceTaskState): { title: string; body: string; tone: 'busy' | 'ok' | 'bad' } {
  if (s.phase === 'asking') return { title: t('dtWorking', { device: s.device }), body: s.asked, tone: 'busy' }
  if (s.phase === 'answered') return { title: t('dtAnswered', { device: s.device }), body: s.answer, tone: 'ok' }
  if (s.phase === 'failed') return { title: t('dtFailed', { device: s.device }), body: failureText(t, s.error), tone: 'bad' }
  return { title: '', body: '', tone: 'ok' }
}

/**
 * The card the composer's `@<device>` path shows, above the input, the way `avatarChat`'s
 * card does: what was asked, then either that the device is on it, its answer, or why it
 * could not finish. A run takes minutes, so something has to say it is out; without this
 * the message went out and the screen said nothing at all.
 */
export function makeDeviceTask(t: Translate) {
  return function DeviceTaskCard(): ReactNode {
    const s = useDeviceTask()
    if (s.phase === 'idle') return null
    const view = deviceTaskView(t, s)
    const steps = s.steps.slice(-5)
    return h('div', { className: `nm-ac nm-dt nm-dt-${view.tone}`, role: 'status', 'aria-label': view.title },
      h('div', { className: 'nm-ac-head' },
        h('span', { className: 'nm-ac-title' }, view.title),
        h('button', { type: 'button', className: 'nm-icon-btn', 'aria-label': t('close'), onClick: deviceTask.dismiss }, h(IconClose, { size: 14 }))),
      h('div', { className: 'nm-ac-cost' },
        view.tone === 'busy' ? h('p', { className: 'nm-ac-status nm-live' }, h(IconSpinner, { size: 14 }), view.body) : h('p', { className: 'nm-ac-desc' }, view.body),
        steps.length ? h('ul', { className: 'nm-dt-steps' }, steps.map((line, i) => h('li', { key: i }, line))) : null))
  }
}

export const deviceTask = {
  /** Send it and follow the run; the card shows where it stands. */
  begin(device: string, deviceId: string, text: string): void {
    const mine = ++round
    set({ ...IDLE, phase: 'asking', device, asked: text })
    call<DeviceAnswer>('devices/ask', { device: deviceId, text })
      .then((r) => {
        if (round !== mine) return
        set({ phase: 'answered', answer: r.answer, steps: Array.isArray(r.steps) ? r.steps : [] })
      })
      .catch((error: unknown) => {
        if (round !== mine) return
        set({ phase: 'failed', error })
      })
  },
  /** The card is done with. */
  dismiss(): void {
    round++
    set(IDLE)
  },
}
