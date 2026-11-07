/**
 * Which device each conversation was switched to (contract C13, `session-owner.ts`).
 *
 * One small record, conversation id → device id, with `''` meaning this computer, kept in
 * localStorage beside `prefs.ts` for the same reason: it is a wish of the person about this
 * window, not account data, and losing it costs nothing worse than a conversation starting again
 * from the device whose chat it is. Conversations are many and the record is one entry each, so
 * it is cut to its newest `MAX_OWNERS` (`trimOwners`).
 *
 * The record is deliberately *not* written to the host (`cloud.ts`). Adding a state field there
 * would put it in `cloud.json`, a file the relay's own protocol flows through, for a fact only
 * this browser's composer reads; the design leaves the place to the client, and this is the
 * smaller of the two changes.
 *
 * A missing entry and a `''` entry are different answers, so they are told apart by
 * `hasOwnProperty` rather than by a falsy check: `undefined` means "nothing has been decided for
 * this conversation, ask the chat's own device", `''` means "the person brought it home with
 * `@本机`", and the two route the next plain sentence to different places.
 */
import { useSyncExternalStore } from 'react'
import { trimOwners } from './session-owner.ts'

const KEY = 'nanomuse.owners'
/** Conversations remembered; the oldest is dropped first (a key keeps its place in the object). */
export const MAX_OWNERS = 200

let owners: Record<string, string> = read()
const listeners = new Set<() => void>()

function read(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [session, owner] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof owner === 'string') out[session] = owner
    }
    return out
  } catch {
    // no record yet, or localStorage is closed to us: every chat starts from its own device
    return {}
  }
}

/**
 * The owner recorded for a conversation: a device id, `''` for this computer, `undefined` when
 * nothing was ever recorded. The three are the input `ownerOf` of `session-owner.ts` reads.
 */
export function ownerOf(sessionId: string | null | undefined): string | undefined {
  if (!sessionId) return undefined
  return Object.prototype.hasOwnProperty.call(owners, sessionId) ? owners[sessionId] : undefined
}

/** Record where a conversation's owner stands now; `''` brings it home. Stays for a restart. */
export function setOwner(sessionId: string | null | undefined, owner: string): void {
  if (!sessionId || owners[sessionId] === owner) return
  owners = trimOwners({ ...owners, [sessionId]: owner }, MAX_OWNERS)
  try {
    window.localStorage.setItem(KEY, JSON.stringify(owners))
  } catch {
    // private mode: the switch holds for this page only
  }
  for (const listener of listeners) listener()
}

/** Forget a conversation's owner (its device chat was removed, or the account changed). */
export function forgetOwner(sessionId: string): void {
  if (!Object.prototype.hasOwnProperty.call(owners, sessionId)) return
  const next = { ...owners }
  delete next[sessionId]
  owners = next
  try {
    window.localStorage.setItem(KEY, JSON.stringify(owners))
  } catch {
    // as above
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The owner of one conversation, re-reading when it changes (the line above the composer). */
export function useOwner(sessionId: string | null | undefined): string | undefined {
  return useSyncExternalStore(
    subscribe,
    () => ownerOf(sessionId),
    () => ownerOf(sessionId),
  )
}
