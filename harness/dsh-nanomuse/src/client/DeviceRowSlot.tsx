/**
 * The row of the account's Muses, above the composer of the desktop app.
 *
 * The phone and the web console each draw this row (Android's `DeviceStrip` + `DeviceFacesRow`,
 * the console's `DeviceFaces.tsx`); the desktop had none, so a device could only be reached by
 * typing its name into the box. Same row, third client: every device of the account as a small
 * disc, the one this app runs on large in the middle, a dot on a device that is waiting on a
 * question here, and a tap that puts that device's `@name` in the composer.
 *
 * Why here and not over the box. The composer's dock is where this app already says things about
 * the chat being written in (the wait line, the allowance note), and the row is not part of the
 * message — it is who the message can go to. Above the box: one glance, one tap.
 *
 * Registered as one slot and self-contained: the decisions are in `device-row.ts` (checked by
 * `tests/device-row.test.mjs` without a renderer), the drawing is here, and nothing else changes.
 */
import { createElement as h, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Avatar } from './Avatar.tsx'
import { prefillComposer } from './composer.ts'
import { faceLabel, focusedFace, muses, newsIds, pickable, tapIntent, type RowFace } from './device-row.ts'
import { IconDevices } from './icons.tsx'
import { peekLive, useLive } from './live.ts'
import type { Translate } from './api.ts'

/** How large each disc is. The large one is the face of the device this app runs on. */
const LARGE = 26
const SMALL = 20
/** The slot is wider than the disc, so the gap between faces reads the same either side. */
const WIDE = LARGE + 8

/**
 * The row. Null when the account has only this computer: a row of one face says nothing about who
 * else there is, and the header already says whose chat is open.
 */
export function DeviceRow({ t, showAsk }: { t: Translate; showAsk?: ((askId: string) => void) | undefined }): ReactNode {
  const live = useLive()
  const box = useRef<HTMLDivElement | null>(null)
  const faces = useMemo(() => muses(live.hub.devices, live.hub.deviceId), [live.hub.devices, live.hub.deviceId])
  const news = useMemo(() => newsIds(live.hub.asks, faces), [live.hub.asks, faces])
  const big = focusedFace(faces)
  const [roll, setRoll] = useState(0)

  // The row rolls to keep the large face in the middle, as the strip does on the phone: the face
  // that was picked is the one the person is looking for, and it may sit at either end.
  useEffect(() => {
    const el = box.current
    if (!el || !big) return
    const face = el.querySelector<HTMLElement>(`[data-device="${CSS.escape(big.device.id)}"]`)
    if (!face) return
    const b = el.getBoundingClientRect()
    const f = face.getBoundingClientRect()
    const max = Math.max(0, el.scrollWidth - el.clientWidth)
    const want = f.left - b.left + el.scrollLeft - (el.clientWidth - f.width) / 2
    el.scrollTo({ left: Math.min(Math.max(want, 0), max) })
  }, [big, roll, faces.length])

  if (faces.length < 2) return null

  const pick = (face: RowFace) => {
    if (!pickable(face)) return
    const intent = tapIntent(face, live.hub.asks)
    // A device waiting on a question leads to that question rather than to the box, or the dot
    // would point at nothing: this client has no per-device chat to open.
    if (intent.kind === 'ask') {
      showAsk?.(intent.deviceId)
      return
    }
    // Every other face addresses the composer to it, which is this client's only way to talk to a
    // device and the same trip typing `@name` takes. This app's own face goes home, and a chat
    // with no target is already its own — so picking it only rolls the row.
    if (intent.kind === 'address') {
      const current = face.device.name
      prefillComposer(`@${current} `)
    }
    setRoll((n) => n + 1)
  }

  return h('div', { className: 'nm-device-row', 'data-testid': 'nm-device-row' },
    h('div', { className: 'nm-device-row-box', ref: box },
      faces.map((face) => {
        const isBig = big?.device.id === face.device.id
        const waiting = news.has(face.device.id)
        const label = faceLabel(face, t('drThisDevice'))
        const hint = !pickable(face)
          ? t('drOffline', { device: label })
          : waiting ? t('drWaiting', { device: label }) : t('drPick', { device: label })
        return h('button', {
          key: face.device.id,
          type: 'button',
          'data-device': face.device.id,
          className: `nm-device-face${isBig ? ' nm-device-face-big' : ''}${face.device.online ? '' : ' nm-device-face-off'}${waiting ? ' nm-device-face-news' : ''}`,
          style: { width: isBig ? WIDE : SMALL + 6 },
          disabled: !pickable(face),
          'aria-label': hint,
          title: hint,
          onClick: () => pick(face),
        },
          h(Avatar, { size: isBig ? LARGE : SMALL, profile: live.profile, still: true, className: 'nm-device-face-disc' }),
          waiting ? h('span', { className: 'nm-device-face-dot', 'data-testid': `nm-device-dot-${face.device.id}` }) : null,
          h('span', { className: 'nm-device-face-name' }, label))
      })),
    // A row that has rolled past its ends holds more than the window shows, which is otherwise
    // only discoverable by trying to scroll it.
    faces.length > 5 ? h('span', { className: 'nm-device-row-more' }, h(IconDevices, { size: 13 })) : null)
}

/**
 * The row as the composer's dock entry.
 *
 * Nothing is drawn until the hub has answered with a device list: before that the account is
 * unknown, and an empty row would be a place on screen that says nothing. `peekLive` is the same
 * store `useLive` reads, so this is the list as it stands right now rather than a second source.
 */
export function makeDeviceRow(t: Translate, showAsk?: ((askId: string) => void) | undefined) {
  return function DeviceRowSlot(): ReactNode {
    const live = peekLive()
    if (!live.hub.connected || live.hub.devices.length === 0) return null
    return h(DeviceRow, { t, showAsk })
  }
}
