/**
 * Which device a conversation belongs to, and where one sentence goes (contract C13).
 *
 * Every conversation has an owner device: the one holding the model's full context for it. A
 * sentence typed here goes to the owner unless the person says otherwise, and `@<device>` moves
 * the owner. `docs/session-handoff.md` §2 is the rule; this file is its reading, in the same
 * plain-function shape as `device-mention.ts`, so the answers can be checked without a window
 * (`tests/session-owner.test.mjs`).
 *
 * ## Three steps, in this order
 *
 * 1. `@本机` or this computer's own name: the sentence runs here, and the owner comes home.
 * 2. `@<device>`: that device runs it, and the owner moves there. `@` beats the owner.
 * 3. otherwise: the owner. Nothing recorded yet, a chat kept for a device
 *    (`device-mention.ts`'s `boundDeviceFor`) says who that is; with neither, this computer.
 *
 * ## Why the owner is not "where the last turn came from"
 *
 * A turn synced in from another device is just text in the conversation; it says nothing about
 * who holds the context. Reading the owner off it would hand the next sentence to whichever
 * device spoke last, which is the opposite of what the person set up. Only `@` moves the owner,
 * and it stays moved: `@Desk`, then a plain sentence, then another, all go to Desk.
 *
 * ## Coming home is a real record, not a missing one
 *
 * `@本机` in a chat kept for Desk must not spring back to Desk on the next plain sentence, so
 * "this computer" is stored as the empty string and a session with no record at all is a
 * different thing (`undefined`). The two read apart with `hasOwnProperty`, which is what
 * `ownerOf` in `device-task.ts` does.
 *
 * ## The line above the box and the routing cannot disagree
 *
 * Both ask `executorOf`. A line that named one device while the words went to another would be
 * worse than no line, and it is exactly the kind of drift two copies of a rule produce.
 */
import { deviceMention, reading, type BoundDevice } from './device-mention.ts'
import type { LiveDevice } from './live.ts'

/** Where a sentence goes: another device of the account, or this computer. */
export type OwnerTarget =
  | { kind: 'device'; id: string; name: string; online: boolean }
  | { kind: 'local' }

/** The owner as the line above the composer reads it; the same resolution the routing uses. */
export type OwnerDevice = BoundDevice

export interface OwnerRouteInput {
  /** What the person typed, as it stands in the box. */
  text: string
  /** This computer's name on the account's list (`live.hub.deviceName`). */
  selfName: string
  /** The name the row gives this computer in the UI language ("This computer", "本机"). */
  thisLabel: string
  /** This computer's hub id, so an owner that turns out to be this computer reads as "here". */
  selfId: string
  /** The account's devices as the hub lists them, this computer included. */
  devices: readonly LiveDevice[]
  /**
   * The owner recorded for this conversation: a device id, `''` for this computer, `undefined`
   * when nothing was ever recorded (`ownerOf` in `device-task.ts`).
   */
  owner: string | undefined
  /** The device whose own chat this is (`boundDeviceFor`), when it is one. */
  bound: OwnerDevice | null | undefined
}

export interface OwnerRoute {
  target: OwnerTarget
  /** The sentence with its mention taken off; unchanged when there was none. */
  text: string
  /**
   * The owner to record for this conversation after this sentence: a device id, `''` for this
   * computer, `undefined` to leave the record as it is (a plain sentence, or a device chat whose
   * binding already says it).
   */
  owner: string | undefined
}

/**
 * The names that mean "this computer" for a mention: the machine's own name on the account, the
 * word the row uses for it in the UI language, and the literal `本机` the design names (a person
 * writing Chinese should not have to know what this computer is called on the account).
 */
export function thisNames(selfName: string, thisLabel: string): string[] {
  return [...new Set(['本机', selfName.trim(), thisLabel.trim()].filter((name) => name !== ''))]
}

/**
 * Whether the sentence opens with this computer's own name. `@本机 tidy up` → `tidy up`. Null when
 * it does not, which is the ordinary case; null too when the mention was the whole message, since
 * an empty task is not a task (`deviceMention` and the runtime's `parse_mention` read it the same).
 */
export function selfMention(text: string, names: readonly string[]): { text: string } | null {
  if (names.length === 0) return null
  const named = reading(text, names)
  return named === null ? null : { text: named.text }
}

/**
 * Where a sentence goes and where the owner stands after it. The three steps above, in order.
 *
 * An owner that this computer cannot call — a device that went offline, or one the account no
 * longer lists — is never quietly rerouted: offline keeps the device as the target, so the send is
 * refused with its name in the message (the design's "owner 离线不发"), and an id the hub does not
 * list falls back to this computer, because there is no frame to build for a device that is not
 * there.
 */
export function routeMessage(input: OwnerRouteInput): OwnerRoute {
  const { text, selfName, thisLabel, selfId, devices, owner, bound } = input

  const home = selfMention(text, thisNames(selfName, thisLabel))
  if (home !== null) return { target: { kind: 'local' }, text: home.text, owner: '' }

  const named = deviceMention(text, devices)
  if (named !== null) {
    const { id, name, online } = named.device
    return { target: { kind: 'device', id, name, online }, text: named.text, owner: id }
  }

  return { target: executorOf(owner, bound, devices, selfId), text, owner: undefined }
}

/**
 * Who runs this conversation: the owner recorded for it, else the device whose chat it is, else
 * this computer. The same resolution the routing takes when no mention is written, which is what
 * keeps the line above the box and the sentence's destination in step.
 */
export function executorOf(
  owner: string | undefined,
  bound: OwnerDevice | null | undefined,
  devices: readonly LiveDevice[],
  selfId: string,
): OwnerTarget {
  const wanted = owner !== undefined ? owner : bound?.id ?? ''
  if (wanted === '' || wanted === selfId) return { kind: 'local' }
  const device = devices.find((d) => d.id === wanted)
  if (!device) return { kind: 'local' }
  return { kind: 'device', id: device.id, name: device.name, online: device.online }
}

/**
 * Whether the line above the composer is worth drawing. It says who runs the conversation, so it
 * belongs where a choice exists: an account with one device would read "Run on this computer" in
 * every chat, which says nothing. A device owner is always worth saying, offline ones most of
 * all — that is the case the person needs to see before typing.
 */
export function executorVisible(
  target: OwnerTarget,
  devices: readonly LiveDevice[],
  selfId: string,
): boolean {
  if (target.kind === 'device') return true
  return otherDevices(devices, selfId).length > 0
}

/** The devices that could be an owner: another device of the account, named. Browser tabs cannot. */
export function otherDevices(devices: readonly LiveDevice[], selfId: string): LiveDevice[] {
  return devices.filter((d) => d.id !== '' && d.id !== selfId && d.kind !== 'web' && d.name.trim() !== '')
}

/**
 * The record, cut to its newest `max` conversations.
 *
 * Owners are one per conversation and conversations are many, so the record would grow without a
 * ceiling; a key keeps its insertion place in a JavaScript object, so the oldest go first. One
 * that leaves only costs a conversation its remembered switch, which starts again from the chat's
 * own device — the fallback the design already has.
 */
export function trimOwners(record: Record<string, string>, max: number): Record<string, string> {
  const keys = Object.keys(record)
  if (max <= 0) return {}
  if (keys.length <= max) return record
  return Object.fromEntries(keys.slice(keys.length - max).map((key) => [key, record[key] as string]))
}
