/**
 * The row of the account's Muses, above the composer of the desktop app.
 *
 * The phone and the web console each draw this row (Android's `DeviceStrip` + `DeviceFacesRow`,
 * the console's `DeviceFaces.tsx`); the desktop had none, so a device could only be reached by
 * typing its name into the box. Same row, third client — and drawn the same way as the other two,
 * which is the point of it being one row in three places rather than three rows:
 *
 * - **A disc is a device, not the agent.** The disc carries a laptop or a phone icon, not the
 *   agent's face: the profile is one per *account*, so every device wears the identical face and a
 *   face says nothing about which disc stands for which device. The name under each disc says the
 *   rest, and this computer says "This computer" — the account's name for it is the same name
 *   every device wears, so under its own disc it would say nothing.
 * - **The row rolls.** The disc of the chat on screen is the middle one, drawn large as it
 *   travels, so a pick reads as the strip being turned rather than the row rearranging itself.
 * - **The disc in the middle is the one whose chat is open.** The chat on screen is matched
 *   against each device's own chat, so opening a device's chat leaves the right disc large. Which
 *   chat that is comes from the dock's own session seat first (`sessionId` — the seat *is* the
 *   chat), with the window store as the fallback.
 *
 * The third answer a tap can have is this client's own. The phone and the console open the
 * device's chat and put a message on the wire; this is a DSH plugin, whose only way to reach
 * another device is the `@name` frame the composer understands (`device-task.ts`). So a tap opens
 * that device's *own chat* — one per device, remembered by the host so the same pick lands in the
 * same window — and puts `@name` in its box. The person finishes the sentence where they always
 * do, and everything said to that device stays in one place.
 *
 * Registered as one slot and self-contained: the decisions are in `device-row.ts` (checked by
 * `tests/device-row.test.mjs` with no renderer), the drawing is here.
 */
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { busyIds, faceLabel, centringScroll, focusedFace, muses, newsIds, pickable, tapIntent, type RowFace } from './device-row.ts'
import { setCurrentSession, useDeviceTask } from './device-task.ts'
import { IconLaptop, IconPhone, IconSpinner } from './icons.tsx'
import { useLive } from './live.ts'
import { useWin } from './win.ts'
import type { Translate } from './api.ts'

/**
 * How large a disc is at rest and how far it shrinks when it is not the middle one. The slot is
 * the large size whatever the disc does, so nothing beside it shifts as one grows.
 */
const DISC = 40
const SHRUNK = 0.62
const SLOT = DISC + 10

/**
 * The device the row was last fitted to, or undefined before the first fit.
 *
 * Kept outside the component on purpose, exactly as the console does it: a pick opens another
 * chat, and the shell rebuilds the composer subtree along with it, so a ref inside would be born
 * fresh on every pick — every roll would then look like a first fit and land without animating,
 * and a pick would never be answered by the strip moving.
 */
let lastFitted: string | undefined

export interface DeviceRowProps {
  t: Translate
  /** Open a device's chat (making it if new), with `@name` already in the box. */
  openChat?: ((deviceId: string, name: string) => void) | undefined
  /** Show a question from another device — the newest one that device is waiting on. */
  showAsk?: ((askId: string) => void) | undefined
  /** Show one of this computer's own chats: the way back out of a device's chat. */
  openMain?: ((chatId: string | null) => void) | undefined
  /**
   * The chat on screen, as the dock's own session seat reports it. `conversation.input.dock` is a
   * session-scope slot, so the shell hands this down; it is the seat that *is* the chat, where
   * `win.current` is written by another seat and only once that one's effect has run.
   */
  sessionId?: string | null | undefined
  /**
   * This computer's own chat, for the face that leads home. Null while the shell does not know
   * which chat that is yet, in which case the face still rolls and stops there.
   */
  mainChat?: string | null | undefined
}

/**
 * The row. Null when the account has only this computer: a row of one disc says nothing about who
 * else there is, and the header already says whose chat is open.
 */
export function DeviceRow({ t, openChat, openMain, showAsk, sessionId, mainChat }: DeviceRowProps): ReactNode {
  const live = useLive()
  // One device task at a time, kept by the composer itself. Subscribing rather than reading
  // once is what lets the disc follow the run from the send to the answer.
  const task = useDeviceTask()
  const win = useWin()
  const box = useRef<HTMLDivElement | null>(null)
  const faces = useMemo(
    () => muses(live.hub.devices, live.hub.deviceId, { chatFor: (id) => live.hub.deviceChats?.[id] ?? null }),
    [live.hub.devices, live.hub.deviceId, live.hub.deviceChats],
  )
  const news = useMemo(() => newsIds(live.hub.asks, faces), [live.hub.asks, faces])
  const busy = useMemo(() => busyIds(task, faces), [task, faces])
  // The chat on screen: the seat's own word first, the store as the fallback. The store is only
  // written once a different seat (the header's utilities) has mounted and run its effect, so on
  // the frame a chat opens it still names the previous one — the seat is never behind.
  const openChatNow = sessionId ?? win.current
  const big = focusedFace(faces, openChatNow)
  // Bumped on every pick, so the roll runs even when the disc to centre is already the middle one
  // — the common case, and the one that would otherwise leave the effect unfired and a pick
  // unanswered by any movement.
  const [pick, setPick] = useState(0)

  useEffect(() => {
    const el = box.current
    if (!el || !big) return
    const face = el.querySelector<HTMLElement>(`[data-device="${CSS.escape(big.device.id)}"]`)
    if (!face) return
    const b = el.getBoundingClientRect()
    const f = face.getBoundingClientRect()
    const left = centringScroll({
      boxLeft: b.left,
      boxWidth: el.clientWidth,
      faceLeft: f.left,
      faceWidth: face.offsetWidth,
      scrollLeft: el.scrollLeft,
      contentWidth: el.scrollWidth,
    })
    // The first fit lands without animating: a chat opening on a device must not slide under the
    // reader's eyes. Everything after that rolls.
    const first = lastFitted === undefined
    lastFitted = big.device.id
    el.scrollTo({ left, behavior: first ? 'auto' : 'smooth' })
  }, [big, pick, faces.length])

  const pick_ = useCallback(
    (face: RowFace) => {
      if (!pickable(face)) return
      setPick((n) => n + 1)
      const intent = tapIntent(face, live.hub.asks, mainChat)
      // A dotted face leads to the question the dot is about, or the dot points at nothing.
      if (intent.kind === 'ask') {
        showAsk?.(intent.deviceId)
        return
      }
      // This computer's face goes home — to the chat of its own the shell named, which is how the
      // person gets back out of a device's chat. The roll above already answered "which disc is in
      // front"; this is the other half of the same tap.
      if (intent.kind === 'main') {
        openMain?.(intent.chat)
        return
      }
      // Every other face opens that device's own chat, making one the first time.
      openChat?.(intent.deviceId, intent.name)
    },
    [live.hub.asks, mainChat, openChat, openMain, showAsk],
  )

  if (faces.length < 2) return null

  return h('div', { className: 'nm-device-row', 'data-testid': 'nm-device-row', role: 'list', 'aria-label': t('drRow') },
    h('div', { className: 'nm-device-row-box', ref: box },
      // Half a slot of slack each end, so the first and last disc can reach the middle too: without
      // it a short account never overflows and "roll to the middle" has nothing to scroll.
      h('span', { 'aria-hidden': true, className: 'nm-device-row-slack' }),
      faces.map((face) => {
        const isBig = big?.device.id === face.device.id
        const waiting = news.has(face.device.id)
        const label = faceLabel(face, t('drThisDevice'))
        const hint = !pickable(face)
          ? t('drOffline', { device: label })
          : waiting ? t('drWaiting', { device: label }) : t('drPick', { device: label })
        // The disc is filled and tinted only when it is the one in front, which is the same
        // emphasis the console puts on the middle disc; the rest are quiet.
        const cls = `nm-device-face${isBig ? ' nm-device-face-big' : ''}${face.device.online ? '' : ' nm-device-face-off'}`
        return h('button', {
          key: face.device.id,
          type: 'button',
          'data-device': face.device.id,
          className: cls,
          style: { width: SLOT },
          disabled: !pickable(face),
          'aria-current': isBig ? 'true' : undefined,
          'aria-label': hint,
          title: hint,
          onClick: () => pick_(face),
        },
          h('span', { className: 'nm-device-face-slot' },
            h('span', {
              className: 'nm-device-face-disc',
              style: { transform: isBig ? 'scale(1)' : `scale(${SHRUNK})` },
            }, h(face.device.kind === 'phone' ? IconPhone : IconLaptop, { size: 20 })),
            // At the disc's foot, so it rides the disc as it grows and stays clear of the name
            // under it. Work under way wins over a question waiting here: the spinner clears
            // itself when the answer lands, the dot does not.
            busy.has(face.device.id)
              ? h('span', {
                  className: 'nm-device-face-busy',
                  'aria-label': t('dtWorking', { device: label }),
                  'data-testid': `nm-device-busy-${face.device.id}`,
                }, h(IconSpinner, { size: 10 }))
              : waiting
                ? h('span', { className: 'nm-device-face-dot', 'data-testid': `nm-device-dot-${face.device.id}` })
                : null),
          h('span', { className: 'nm-device-face-name' }, label))
      }),
      h('span', { 'aria-hidden': true, className: 'nm-device-row-slack' })))
}

/**
 * The row as the composer's dock entry.
 *
 * Nothing is drawn until the hub has answered with a device list — before that the account is
 * unknown, and an empty row would be a place on screen that says nothing.
 *
 * This subscribes rather than reading once. The hub's handshake finishes *after* the chat mounts,
 * so a one-shot read at mount lands on `connected: false` and the gate below returns null for
 * good: the row would be empty for the whole session, however long the hub had been up. Reading
 * through the hook is what makes the row appear when the list arrives.
 */
export function makeDeviceRow(
  t: Translate,
  openChat?: ((deviceId: string, name: string) => void) | undefined,
  showAsk?: ((askId: string) => void) | undefined,
  openMain?: ((chatId: string | null) => void) | undefined,
  mainChatOf?: (() => string | null) | undefined,
) {
  // The dock is a session-scope slot, so the shell hands the chat on screen down as `sessionId`.
  // Read it off the props rather than through the window store: the store is written by the
  // header's own seat, which mounts beside this one, so on the frame a chat opens it still names
  // the chat before it (measured: `win` empty while this seat already had the right id).
  return function DeviceRowSlot(props?: { sessionId?: string | undefined } | undefined): ReactNode {
    // The dock is a session-scope slot: the seat it is mounted in *is* the chat on screen.
    // Hand that id to the composer interceptor so a device's own chat sends its words to that
    // device by itself, rather than depending on an `@name` prefill a session switch can lose.
    setCurrentSession(props?.sessionId)
    const live = useLive()
    if (!live.hub.connected || live.hub.devices.length === 0) return null
    return h(DeviceRow, { t, openChat, openMain, showAsk, sessionId: props?.sessionId ?? null, mainChat: mainChatOf?.() ?? null })
  }
}
