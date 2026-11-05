/**
 * The account's Muses as one row, for the desktop app's composer.
 *
 * The phone and the web console each draw this row (Android's `DeviceStrip`, the console's
 * `device-strip.ts`); the desktop had none, so the only way to reach another device from here was
 * to type its name. This is the same row on the third client: one face per device, the one whose
 * chat is open drawn large in the middle and the rest beside it, a tap opening that device's chat.
 *
 * Why the decisions live in this file rather than in the view. Two clients already answer these
 * questions (`muses`, `focusedFace`, `hasNews`), and a third answer that drifted would show a
 * person two different rows for one account. Keeping them plain functions also means they can be
 * checked with `node --test` and no renderer, which is how everything else here is checked.
 *
 * What is *not* here, and why. The phone keeps a chat per device (`DeviceChat`) and marks a device
 * unread when that chat has moved on (`DeviceNews`); the console reads the same from the runtime's
 * thread list. The desktop app has no chat per device — its `device-task.ts` runs an addressed
 * message inside the open chat, and the harness owns the session list — so there is nothing here
 * to weigh for "unread". A dot is therefore drawn only for the one thing this client can know on
 * its own: a question from another device waiting to be answered here (`LiveAsk`), which is the
 * same signal the phone calls "something arrived for this device". Where the phone opens the
 * newest unread chat, this opens the device that asked.
 */
import type { LiveAsk, LiveDevice } from './live.ts'

/** One face of the row: which device, whether it is the one this app runs on. */
export interface RowFace {
  device: LiveDevice
  /** The device this app is signed in as — the row's own, and the one a chat with no target means. */
  isThis: boolean
}

/**
 * Whether a device is this one. The hub's list carries no `this` flag (unlike the relay's, which
 * the console reads), so it is decided by the hub's own `deviceId`: the device the app is
 * connected as is the one being held. A blank id matches nothing, which is right — with no hub
 * connection there is no "this" to draw large.
 */
export function isThisDevice(device: Pick<LiveDevice, 'id'>, hubDeviceId: string): boolean {
  return device.id !== '' && device.id === hubDeviceId
}

/**
 * Every Muse of the account, in the order the row holds them: this device first, then the online
 * ones by name, then the sleeping ones. Browser tabs are left out (nothing there to talk to) and
 * so is a nameless entry — the same two exclusions the phone and the console make, so the same
 * account draws the same row on all three.
 *
 * The order does not depend on which chat is open. It is what makes the row readable as a strip
 * that can be turned: an order that answered "whose chat is open" would move the large face to an
 * end every time and the row would never appear to roll.
 */
export function muses(devices: readonly LiveDevice[], hubDeviceId: string): RowFace[] {
  return devices
    .filter((d) => d.kind !== 'web' && d.name.trim() !== '')
    .slice()
    .sort((a, b) => {
      const at = isThisDevice(a, hubDeviceId)
      const bt = isThisDevice(b, hubDeviceId)
      if (at !== bt) return at ? -1 : 1
      if (a.online !== b.online) return a.online ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    .map((device) => ({ device, isThis: isThisDevice(device, hubDeviceId) }))
}

/**
 * The face drawn large in the middle: the device this app runs on, or the first face when the hub
 * has not named one. The desktop's chat is always this computer's own — it has no per-device chat
 * to be aimed at — so "this device" is the only answer, and the row never has a second opinion
 * about it. Null only when the account has no device at all.
 */
export function focusedFace(row: readonly RowFace[]): RowFace | null {
  return row.find((f) => f.isThis) ?? row[0] ?? null
}

/**
 * Which faces wear the dot.
 *
 * One signal, because it is the only one this client can know: a device that asked this computer
 * something and is waiting for the answer (`LiveAsk`, the same `asks` list the approvals card is
 * built from). A device that has simply sent work does not appear — the desktop runs an addressed
 * message in the open chat, so there is no separate place for it to accumulate, and a dot that
 * pointed at the chat already on screen would say nothing.
 *
 * Keyed by device id, and a dot stands while anything from that device is unanswered: two
 * questions from one device are one dot, which is what a glance is for. `fromId` is what the
 * runtime sets for the asker, so it is what the row compares against.
 */
export function newsIds(asks: readonly LiveAsk[], row: readonly RowFace[]): Set<string> {
  const ids = new Set<string>()
  if (asks.length === 0) return ids
  const known = new Set(row.map((f) => f.device.id))
  for (const ask of asks) {
    if (known.has(ask.fromId)) ids.add(ask.fromId)
  }
  return ids
}
/**
 * What a tap on a face asks the shell to do.
 *
 * `main` — go back to this computer's own chat, which is what picking this computer's face means
 * (there is no chat *with* it; the phone and the console read it the same way). `address` — put
 * this device's `@name` in the composer, which is this client's only way to talk to one and the
 * same trip typing it by hand takes. `ask` — show the question that device is waiting on, because
 * a face wearing a dot has to lead to what the dot is about.
 *
 * Kept as a value rather than performed here so the rule can be checked without a window.
 */
export type FaceIntent =
  | { kind: 'main' }
  | { kind: 'address'; deviceId: string }
  | { kind: 'ask'; deviceId: string }

/**
 * Where a tap lands.
 *
 * Three answers, because this client can do three things and no more. A device that asked here and
 * is still waiting (`LiveAsk`) leads to that question — the dot has to open what it is about, or it
 * points at nothing, and the desktop has no per-device chat in which to *find* it. Any other device
 * leads to the composer addressed to it, which is the same trip as typing `@name` and the only way
 * this client can talk to one. This computer's own face goes home — a chat with no target is this
 * computer's own, so picking it is how a chat comes back to it.
 *
 * The newest asker wins when a device asked more than once: the newest question is the one a person
 * coming back to the screen is looking for, and answering it leaves the older ones for the next tap.
 */
export function tapIntent(face: RowFace, asks: readonly LiveAsk[]): FaceIntent {
  const asked = newestAskFrom(face.device.id, asks)
  if (asked) return { kind: 'ask', deviceId: face.device.id }
  if (face.isThis) return { kind: 'main' }
  return { kind: 'address', deviceId: face.device.id }
}

/** The newest unanswered question from [deviceId], or null when that device is not waiting on one. */
export function newestAskFrom(deviceId: string, asks: readonly LiveAsk[]): LiveAsk | null {
  let best: LiveAsk | null = null
  for (const ask of asks) {
    if (ask.fromId !== deviceId) continue
    if (best === null || ask.at >= best.at) best = ask
  }
  return best
}

/**
 * The label under a face. The device this app runs on wears "This computer" rather than the
 * account's name for it, which is the same name every other device wears (the profile is one per
 * account), so under its own disc it would say nothing. The phone says "This device" for the same
 * reason.
 */
export function faceLabel(face: RowFace, thisLabel: string): string {
  return face.isThis ? thisLabel : face.device.name
}

/**
 * Whether a face may be picked. A sleeping device is still drawn (faint, so the row shows the
 * whole account) but a tap on it cannot go anywhere: the phone says so in words rather than
 * opening an empty chat, and this client does the same from the view.
 */
export function pickable(face: RowFace): boolean {
  return face.device.online
}
