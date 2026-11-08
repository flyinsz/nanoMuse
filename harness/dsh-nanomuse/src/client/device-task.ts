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
import { boundDeviceFor, deviceMention, type BoundDevice } from './device-mention.ts'
import { ownerOf, setOwner } from './owner-store.ts'
import { executorOf, routeMessage, type OwnerTarget } from './session-owner.ts'
import { IconSpinner } from './icons.tsx'
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
  /** The hub id, so the device strip can wear the spinner on the disc the run went to. */
  deviceId: string
  /** The chat this run belongs to: the host keeps its question and answer as lines of that chat. */
  sessionId: string
  /** What was asked, kept so the card can say it while the run is out. */
  asked: string
  answer: string
  steps: string[]
  /** The failure as it came; the card words it through `failureText`. */
  error?: unknown
}

const IDLE: DeviceTaskState = { phase: 'idle', device: '', deviceId: '', sessionId: '', asked: '', answer: '', steps: [] }

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

/**
 * The chat on screen, as the dock's own session seat reports it. The window store is written
 * by a different seat and lags a frame; the seat itself *is* the chat, so it is the one to
 * trust when deciding where a message belongs.
 */
let currentSession: string | null = null

/** The device row hands the chat on screen down; the composer interceptor reads it from here. */
export function setCurrentSession(sessionId: string | null | undefined): void {
  currentSession = sessionId ?? null
}

/** The device whose own chat is on screen, when there is one. */
export function boundDevice(): BoundDevice | null {
  const hub = peekLive().hub
  return boundDeviceFor(currentSession, hub.deviceChats, hub.devices)
}

/**
 * The device the relay says holds this conversation's context (C13), or undefined when it has
 * not said. This is the conversation's own owner, read back from the sync reply — the fact the
 * design wants carried (`docs/session-handoff.md` §2: ownership is about *the conversation*,
 * not about where the last message came from), so a chat another device has been running is
 * held by it here and the next plain sentence goes there without an `@`.
 *
 * The account's main chat is the one exception: every device holds its own copy of it, and the
 * relay keeps a single row for all of them, so an owner read there is one device's turn-taking
 * fact about a chat this computer also has. Following it would leave this computer unable to use
 * its own main chat. That device's context is reachable from its own chat, which its face opens.
 *
 * A record the person made by hand wins over it (`ownerOf` is asked first): `@本机` is an
 * explicit wish about this window, and the relay's word must not undo it.
 */
export function relayOwner(): string | undefined {
  if (!currentSession) return undefined
  if (currentSession === peekLive().sync?.mainSession) return undefined
  const device = peekLive().sync?.deviceOwners?.[currentSession]
  return device === undefined || device === '' ? undefined : device
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

/**
 * Where a sentence typed here goes (C13): the `@` it opens with, else the conversation's owner,
 * else the device whose chat it is, else this computer. The rules are `session-owner.ts`; this
 * reads the live state and the record for them, and hands back the mention taken out of the text
 * together with the owner to record. `thisLabel` is the word the row gives this computer
 * (`drThisDevice`), so `@本机` and this machine's own name both come home.
 */
export function takeRoute(text: string, thisLabel: string): { target: OwnerTarget; text: string } {
  const hub = peekLive().hub
  const route = routeMessage({
    text,
    selfName: hub.deviceName,
    thisLabel,
    selfId: hub.deviceId,
    devices: hub.devices,
    owner: effectiveOwner(),
    bound: boundDevice(),
  })
  // A mention that moved the owner is written down here, so the next plain sentence follows it;
  // a plain sentence leaves the record alone. One function, so no caller can route without
  // recording, and the line above the composer can never disagree with where the words went.
  if (route.owner !== undefined) setOwner(currentSession, route.owner)
  return { target: route.target, text: route.text }
}

/**
 * The owner a plain sentence goes to: the person's own record for this chat (`@` and `@本机`
 * write it), else the relay's word on the conversation. One function for the routing and the
 * line above the composer, so the two cannot name different devices — a line that said one
 * device while the words went to another is worse than no line (`session-owner.ts`).
 */
export function effectiveOwner(): string | undefined {
  const recorded = ownerOf(currentSession)
  return recorded !== undefined ? recorded : relayOwner()
}

/** Who runs the conversation on screen right now, for the line above the composer. */
export function currentExecutor(): OwnerTarget {
  const hub = peekLive().hub
  return executorOf(effectiveOwner(), boundDevice(), hub.devices, hub.deviceId)
}

/** What a card needs to word itself, in the UI language. */
export function deviceTaskView(t: Translate, s: DeviceTaskState): { title: string; body: string; tone: 'busy' | 'ok' | 'bad' } {
  if (s.phase === 'asking') return { title: t('dtWorking', { device: s.device }), body: s.asked, tone: 'busy' }
  if (s.phase === 'answered') return { title: t('dtAnswered', { device: s.device }), body: s.answer, tone: 'ok' }
  if (s.phase === 'failed') return { title: t('dtFailed', { device: s.device }), body: failureText(t, s.error), tone: 'bad' }
  return { title: '', body: '', tone: 'ok' }
}

/**
 * The composer's `@<device>` path: the question and the answer are lines of the chat itself,
 * kept by the host (`cloud.ts` `askDevice`), so a run survives a closed progress line, a chat
 * left, and a restart. All this seat does is say the run is out, in the chat it belongs to, for
 * as long as it is out — one line above the composer instead of a card over the frame. The
 * device's disc wears a spinner too, and the chat's own C9 line says what step the run is on.
 */
export function makeDeviceTask(t: Translate) {
  return function DeviceTaskLine(props?: { sessionId?: string | undefined } | undefined): ReactNode {
    // A second place the chat on screen is known: this seat has its own session id, so the
    // composer's interceptor is not left guessing if the device row's seat ever mounts first.
    if (props?.sessionId) setCurrentSession(props.sessionId)
    const s = useDeviceTask()
    if (s.phase !== 'asking') return null
    // A session-scope seat: a run belongs to one chat. Leaving for another chat must not carry
    // its progress along, and coming back must find it still there.
    if (props?.sessionId && s.sessionId && s.sessionId !== props.sessionId) return null
    const view = deviceTaskView(t, s)
    return h('div', { className: 'nm-dt-line', role: 'status', 'aria-label': view.title },
      h(IconSpinner, { size: 14 }),
      h('span', { className: 'nm-dt-line-title' }, view.title),
      h('span', { className: 'nm-dt-line-asked' }, s.asked))
  }
}

export const deviceTask = {
  /** Send it; the host keeps the question and the answer as lines of the chat on screen. */
  begin(device: string, deviceId: string, text: string): void {
    const mine = ++round
    const sessionId = currentSession ?? ''
    set({ ...IDLE, phase: 'asking', device, deviceId, asked: text, sessionId })
    call<DeviceAnswer>('devices/ask', { device: deviceId, text, sessionId })
      .then((r) => {
        if (round !== mine) return
        set({ phase: 'answered', answer: r.answer, steps: Array.isArray(r.steps) ? r.steps : [] })
      })
      .catch((error: unknown) => {
        if (round !== mine) return
        set({ phase: 'failed', error })
      })
  },
}
