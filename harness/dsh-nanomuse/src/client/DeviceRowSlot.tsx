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
 * - **The row rolls.** Picking a device scrolls the strip until that disc is the middle one,
 *   growing to full size as it travels, so a tap reads as the strip being turned rather than the
 *   row rearranging itself. The first fit lands without animating, or a chat that opens on a
 *   device would slide under the person's eyes.
 * - **The disc in the middle is the one whose chat is open.** The current session's id
 *   (`win.current`) is matched against each device's own chat, so opening a device's chat
 *   elsewhere in the app leaves the right disc large.
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
import { faceLabel, centringScroll, focusedFace, muses, newsIds, pickable, tapIntent, type RowFace } from './device-row.ts'
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

export interface DeviceRowProps {
  t: Translate
  /** Open a device's chat (making it if new), with `@name` already in the box. */
  openChat?: ((deviceId: string, name: string) => void) | undefined
  /** Show a question from another device — the newest one that device is waiting on. */
  showAsk?: ((askId: string) => void) | undefined
}

/**
 * The row. Null when the account has only this computer: a row of one disc says nothing about who
 * else there is, and the header already says whose chat is open.
 */
export function DeviceRow({ t, openChat, showAsk }: DeviceRowProps): ReactNode {
  const live = useLive()
  const win = useWin()
  const box = useRef<HTMLDivElement | null>(null)
  const faces = useMemo(
    () => muses(live.hub.devices, live.hub.deviceId, { chatFor: (id) => live.hub.deviceChats?.[id] ?? null }),
    [live.hub.devices, live.hub.deviceId, live.hub.deviceChats],
  )
  const news = useMemo(() => newsIds(live.hub.asks, faces), [live.hub.asks, faces])
  const big = focusedFace(faces, win.current)
  // Bumped on every pick, so the roll runs even when the disc to centre is already the middle one
  // — the common case, and the one that would otherwise leave the effect unfired and a tap
  // unanswered by any movement.
  const [pick, setPick] = useState(0)
  // The first fit lands without animating: a chat opening on a device must not slide under the
  // reader's eyes. Everything after that rolls.
  const firstFit = useRef(true)

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
    const smooth = !firstFit.current
    firstFit.current = false
    el.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' })
  }, [big, pick, faces.length])

  const pick_ = useCallback(
    (face: RowFace) => {
      if (!pickable(face)) return
      setPick((n) => n + 1)
      const intent = tapIntent(face, live.hub.asks)
      // A dotted face leads to the question the dot is about, or the dot points at nothing.
      if (intent.kind === 'ask') {
        showAsk?.(intent.deviceId)
        return
      }
      // This computer's face goes home; the roll already answered "which disc is in front".
      if (intent.kind === 'main') return
      // Every other face opens that device's own chat, making one the first time.
      openChat?.(intent.deviceId, intent.name)
    },
    [live.hub.asks, openChat, showAsk],
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
            // A device waiting on a question here wears the dot, at the disc's foot so it rides the
            // disc as it grows and stays clear of the name under it.
            waiting ? h('span', { className: 'nm-device-face-dot', 'data-testid': `nm-device-dot-${face.device.id}` }) : null),
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
) {
  return function DeviceRowSlot(): ReactNode {
    const live = useLive()
    if (!live.hub.connected || live.hub.devices.length === 0) return null
    return h(DeviceRow, { t, openChat, showAsk })
  }
}
