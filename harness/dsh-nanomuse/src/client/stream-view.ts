/**
 * Which of the account's running turns are worth drawing, and in what order (contract C13, §4).
 *
 * `stream-buckets.ts` merges the relay's batches into buckets and `hub.ts` keeps them; the host
 * resolves each to the chat that conversation is here, and this decides what the thread shows.
 * It stays apart from the drawing (`StreamBubbles.ts`) so the rules can be pinned with
 * `node --test` and no renderer, the way the rest of this client is.
 *
 * ## Two runs, one chat
 *
 * The whole point of the `round` on a frame: a chat can have two turns going at once, and each is
 * a bubble of its own. The key carries the conversation as well, so two chats cannot collide.
 *
 * ## When a bubble goes
 *
 * A relay's `stream` frames are fire and forget; the round's final text arrives as an ordinary
 * synced turn (the design's "最终文本由 sync 兜底"). So a `done` round's bubble is kept for a
 * short grace while its reply lands, and dropped after: a half-written bubble must not outlive
 * the real text next to it. A round that went quiet without any `done` at all is bounded by
 * `STREAM_TTL_MS`, the same limit the host prunes its own map by. A round with nothing in it yet
 * draws nothing, so a lone `done` for a lost opening batch leaves no empty bubble behind.
 */
import type { LiveStream } from './live.ts'

/**
 * How long a finished round's bubble is kept while its final text lands as a synced turn. Long
 * enough to cover the pull that follows the `done`, short enough that a lost one does not linger.
 */
export const STREAM_GRACE_MS = 20_000

/** How long a round that never said `done` may keep a bubble: the same bound the host prunes by. */
export const STREAM_QUIET_MS = 2 * 60_000

/** The key a round's bubble lives under, both in the map and on the node. */
export function streamKeyOf(cid: string, round: string): string {
  return `${cid}\u0000${round}`
}

/** Whether a round has anything to draw at all: words, reasoning, or a step. */
export function hasSomethingToDraw(stream: LiveStream): boolean {
  return Boolean(stream.text.trim() || stream.reasoning.trim() || stream.tools.length > 0)
}

/**
 * The bubbles this chat shows, oldest first, so the newest sits nearest the composer. A round
 * from this computer is left out (the relay does not echo the sender, but a bucket kept across
 * a reconnection could name it), as is one with nothing in it, one whose `done` has long passed,
 * and one that went quiet.
 */
export function streamBubbles(
  streams: readonly LiveStream[] | undefined,
  session: string,
  options: { selfId?: string; now?: number; graceMs?: number; quietMs?: number; deviceOf?: string } = {},
): LiveStream[] {
  if (!streams || !session) return []
  const now = options.now ?? Date.now()
  const grace = options.graceMs ?? STREAM_GRACE_MS
  const quiet = options.quietMs ?? STREAM_QUIET_MS
  const self = options.selfId ?? ''
  // A round handed to a device runs on *that* device's own main conversation (C13 §3), so its
  // frames are resolved to the main chat — and [deviceOf] names the device whose chat this is.
  // Its rounds belong here as well, so the chat with that Muse shows it working rather than
  // standing empty while it is the one answering.
  const device = options.deviceOf ?? ''
  return streams
    .filter((s) => (s.session === session || (device !== '' && s.from === device)) && s.round !== '' && s.from !== self)
    .filter(hasSomethingToDraw)
    .filter((s) => now - s.at < (s.done ? grace : quiet))
    .sort((a, b) => a.at - b.at || a.round.localeCompare(b.round))
}

/**
 * How a step's row reads: its name, and what it found when the result came back. The words are
 * the runtime's own (`summary`), never re-worded here; an empty summary is just the name.
 */
export function toolLine(tool: LiveStream['tools'][number]): string {
  const summary = tool.summary.trim()
  return summary ? `${tool.name} \u00b7 ${summary}` : tool.name
}
