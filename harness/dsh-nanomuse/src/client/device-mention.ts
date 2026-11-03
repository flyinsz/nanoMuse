/**
 * `@Mac tidy the downloads folder`: the person addressed another device of the account, and
 * the message is work for that device. This decides that, so the message can go straight to
 * that device's own Muse over the hub (`task`) instead of opening a turn here.
 *
 * The matching rules are `nanomuse/sync/mention.py` (`parse_mention`), the runtime's own
 * reading of the same line, so a message typed here and the same message typed in the web
 * console address the same device. Kept in step with `web/src/mention.ts`, the phone's
 * `DeviceTargetMention.kt` and the iPhone's `NanoMuseDeviceMention`.
 *
 * Which of the two paths a message takes is not a matter of taste. A mention handed to the
 * local Muse is a note asking the model to relay it with `delegate`: the model still runs a
 * whole turn, it may reword what was asked, and nothing stops it doing the work itself.
 * Sending the frame directly costs no turn and cannot be reinterpreted.
 */
import type { LiveDevice } from './live.ts'

/** A device that was addressed, and what is left of the message once the mention is gone. */
export interface DeviceMentionHit {
  device: LiveDevice
  text: string
}

const SEPARATORS = new Set([' ', '\t', ',', ':', ';', '，', '：', '；'])
const BOUNDARY = /[\s,:;，：；]/

/**
 * The rule on names alone: which of them a message that opens with `@` addresses, and what is
 * left once the mention is gone. Null when it addresses none, or when the mention was the
 * whole message: an empty task is not a task, so the caller leaves the text as it was.
 *
 * A whole name at the start wins, the longest when two names share a start; failing that the
 * first word after `@` as the start of exactly one name. `parse_mention` reads it the same way.
 */
export function reading(text: string, names: readonly string[]): { name: string; text: string } | null {
  const body = text.trimStart()
  if (!body.startsWith('@') || body.length < 2) return null
  const rest = body.slice(1)

  const whole = names
    .map((n) => n.trim())
    .filter((n) => n.length > 0 && endsAtBoundary(rest, n))
    .sort((a, b) => b.length - a.length)[0]
  if (whole !== undefined) return cut(whole, rest, whole.length)

  const word = takeWhile(rest, (c) => !SEPARATORS.has(c)).toLowerCase()
  if (word.length === 0) return null
  const hits = names.map((n) => n.trim()).filter((n) => n.toLowerCase().startsWith(word))
  const name = hits.length === 1 ? hits[0] : undefined
  if (name === undefined) return null
  return cut(name, rest, word.length)
}

/** Case-insensitively, the way `mention.py` does it, and then a separator or the end. */
function endsAtBoundary(rest: string, name: string): boolean {
  if (rest.length < name.length) return false
  if (rest.slice(0, name.length).toLowerCase() !== name.toLowerCase()) return false
  return rest.length === name.length || BOUNDARY.test(rest.charAt(name.length))
}

function takeWhile(text: string, keep: (c: string) => boolean): string {
  let i = 0
  while (i < text.length && keep(text.charAt(i))) i++
  return text.slice(0, i)
}

function cut(name: string, rest: string, used: number): { name: string; text: string } | null {
  let remainder = rest.slice(used)
  while (remainder.length > 0 && (/\s/.test(remainder.charAt(0)) || SEPARATORS.has(remainder.charAt(0)))) {
    remainder = remainder.slice(1)
  }
  if (remainder.trim() === '') return null
  return { name, text: remainder }
}

/**
 * The device `text` addresses, when it is one of [devices] and it is online, with the mention
 * taken out. Null otherwise, so the ordinary path keeps the message.
 */
export function deviceMention(text: string, devices: readonly LiveDevice[]): DeviceMentionHit | null {
  const reachable = devices.filter((d) => d.online && d.name.trim().length > 0)
  if (reachable.length === 0) return null
  const named = reading(text, reachable.map((d) => d.name))
  if (named === null) return null
  const device = reachable.find((d) => d.name.trim().toLowerCase() === named.name.toLowerCase())
  if (device === undefined) return null
  return { device, text: named.text }
}