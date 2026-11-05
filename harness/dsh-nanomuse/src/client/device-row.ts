/**
 * The account's devices as one row, for the desktop app's composer.
 *
 * The phone and the web console each draw this row (Android's `DeviceStrip`, the console's
 * `device-strip.ts`); the desktop had none, so the only way to reach another device from here was
 * to type its name. Same row, third client: one disc per device, the one whose chat is open drawn
 * large in the middle and the rest beside it.
 *
 * ## The disc carries the device, not the agent
 *
 * A disc draws what the device *is* — a laptop or a phone (`IconLaptop` / `IconPhone`) — rather
 * than the agent's face, which is what the phone and the console do and for the same reason: the
 * profile (name, face, colour) is one per *account*, so every device of it wears the identical
 * face and a face says nothing about which device a disc stands for. The name under each disc
 * says the rest. Drawing the face here was the first cut and it was wrong — five identical faces
 * with only the labels to tell them apart, which is not what the other two clients show.
 *
 * ## The roll, and why the order must not depend on the open chat
 *
 * The row is a window on a longer strip that rolls sideways. Picking a device scrolls it until
 * that disc is the middle one, growing as it travels — that is what makes the row read as one
 * thing being turned rather than a row of buttons. The order therefore cannot answer "whose chat
 * is open": that would leave the picked disc in the same slot every time, the window would never
 * need to move, and a tap would look like the row rearranging itself instead of the strip being
 * turned. `muses` holds the same order the phone does (`DeviceStrip.muses`).
 *
 * ## Three answers a tap can have
 *
 * The phone and the console both open the device's own chat, because both have a hub to carry a
 * message to that device. This client is a DSH plugin: its chat belongs to the harness, and the
 * only way it can talk to another device is the `@name` frame the composer already understands
 * (`device-task.ts`, `device-mention.ts`). So a tap is one of:
 *
 * - the device asked here and is waiting (`LiveAsk`) → show that question; a disc wearing a dot
 *   has to open what the dot is about, or it points at nothing;
 * - this computer's own face → back to a chat of its own, which is what "no target" means;
 * - any other device → a *chat of its own*, one per device, with `@name` already in the box.
 *
 * That last one is the device chat, and it is why this file is more than a sort: a device's chat
 * is a window the person returns to, so picking the same device twice must land in the same one
 * rather than making a second. The mapping is kept by the host (`roomsDevices.chatFor`), which is
 * the side that can persist across a restart, and looked up here through `nav`.
 *
 * The decisions are plain functions apart from the view, so they can be checked with
 * `node --test` and no renderer — which is how everything else here is checked.
 */
import type { LiveAsk, LiveDevice } from './live.ts'

/** One face of the row: which device, whether it is the one this app runs on. */
export interface RowFace {
  device: LiveDevice
  /** The device this app is signed in as — the row's own, and the one a chat with no target means. */
  isThis: boolean
  /** The chat this device already has, so a tap returns to it instead of making a second one. */
  chat: string | null
}

/** What the view needs from the host to draw and drive the row. */
export interface RowHooks {
  /** The session a device's chat lives in, from the host's own record; null when it has none yet. */
  chatFor(deviceId: string): string | null
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
export function muses(
  devices: readonly LiveDevice[],
  hubDeviceId: string,
  hooks?: RowHooks,
): RowFace[] {
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
    .map((device) => ({
      device,
      isThis: isThisDevice(device, hubDeviceId),
      chat: device.id ? hooks?.chatFor(device.id) ?? null : null,
    }))
}

/**
 * The face drawn large in the middle: the device whose chat is open, or — when the chat goes
 * nowhere in particular (the main chat, a side chat) — this device, since a chat with no device
 * open is this device's own.
 *
 * `openChat` is the session the harness is showing. This client has one chat at a time and the
 * harness owns which; when its id is one of the row's device chats, that device is the middle
 * one. Null only when the account has no device at all.
 */
export function focusedFace(row: readonly RowFace[], openChat?: string | null): RowFace | null {
  if (openChat) {
    const open = row.find((f) => f.chat === openChat)
    if (open) return open
  }
  return row.find((f) => f.isThis) ?? row[0] ?? null
}

/**
 * Which faces wear the dot.
 *
 * One signal, because it is the only one this client can know: a device that asked this computer
 * something and is waiting for the answer (`LiveAsk`, the same `asks` list the approvals card is
 * built from). A device that has simply sent work does not appear — a chat of its own that has
 * moved on is the console's "news", and the desktop has no per-device unread to read.
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
 * `main` — show a chat of this computer's own, which is what picking this computer's face means
 * and how the person gets back out of a device's chat. `ask` — show the question that device is
 * waiting on, because a face wearing a dot has to lead to what the dot is about. `chat` — open
 * that device's own chat, making one if it has never had one, and which is the same trip the
 * phone and the console take.
 *
 * Picking this computer's face is deliberately *not* "close the device chat and make a new one":
 * a chat of its own already means "no target", so the tap only has to make sure one is showing.
 */
export type FaceIntent =
  | { kind: 'main' }
  | { kind: 'chat'; deviceId: string; name: string; chat: string | null }
  | { kind: 'ask'; deviceId: string }

/**
 * Where a tap lands.
 *
 * A device that asked here and is still waiting leads to that question first, whatever else is
 * true of it: a dot that did not open what it is about would point at nothing. This computer's own
 * face goes home. Every other device leads to its chat — the newest asker does not win over the
 * dot's own device, because the dot *is* the tap's answer for the device that asked.
 */
export function tapIntent(face: RowFace, asks: readonly LiveAsk[]): FaceIntent {
  if (!face.isThis && newestAskFrom(face.device.id, asks)) {
    return { kind: 'ask', deviceId: face.device.id }
  }
  if (face.isThis) return { kind: 'main' }
  return { kind: 'chat', deviceId: face.device.id, name: face.device.name, chat: face.chat }
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

/**
 * Where the strip must scroll so [face] sits in the middle of [box], in the same shape the console
 * uses (`device-strip.ts`'s `centringScroll`), so both roll the same way.
 *
 * Worked from screen coordinates rather than `offsetLeft`, which is measured from the offset
 * parent that a flex row does not establish, and rather than `scrollIntoView({inline:'center'})`,
 * whose "centre" every engine resolves against a different scrollable ancestor.
 */
export function centringScroll(input: {
  boxLeft: number
  boxWidth: number
  faceLeft: number
  faceWidth: number
  scrollLeft: number
  contentWidth: number
}): number {
  const { boxLeft, boxWidth, faceLeft, faceWidth, scrollLeft, contentWidth } = input
  // the box's left edge measures where the *content* is scrolled to, so taking the scroll back
  // out gives the face's own place in the content, on screen or not
  const contentStart = boxLeft - scrollLeft
  const faceOffset = faceLeft - contentStart
  const wanted = faceOffset - (boxWidth - faceWidth) / 2
  const max = Math.max(0, contentWidth - boxWidth)
  return Math.min(Math.max(wanted, 0), max)
}
