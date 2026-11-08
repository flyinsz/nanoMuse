/**
 * A turn in progress on another device, drawn in this conversation (contract C13, §4).
 *
 * The owner of a conversation runs a turn and sends its output in batches over the relay's
 * `stream` frame (`docs/session-handoff.md` §4; the frozen shape is `docs/tasks/session-handoff-impl.md`
 * §B). Every device of the account sees the same frames, so this decides which stream a frame
 * belongs to and merges it into one growing bubble.
 *
 * ## Rounds are the key, not conversations
 *
 * One conversation can have several streams at once — a turn still finishing while the next
 * starts, two devices asking at the same moment. Web keys its streams by conversation
 * (`state.streams[thread]`) and two streams overwrite each other there; the frame's `round`
 * is the fix, so this buckets by `cid` + `round` and keeps them apart.
 *
 * ## Why the state is a plain map
 *
 * The renderer wants to update one bubble in place rather than re-render the thread, and a plain
 * object of buckets is what a `Map` of DOM nodes hangs off. Everything here is a pure function of
 * (state, frame), so the merging — the part where a batch is appended, a lone `done` closes a
 * round, and a late frame after `done` is dropped — can be checked with `node --test` and no
 * renderer, the way the rest of this client is.
 *
 * ## What a bubble holds
 *
 * `text` and `reasoning` are the two growing strings; `tools` is the ordered list of tool calls
 * and their results, because a tool row that vanishes between batches would flicker. `seq` is the
 * last sequence seen, and a frame at or below it is a duplicate from a reconnecting relay and is
 * dropped rather than appended twice.
 */
import type { LiveDevice } from './live.ts'

/** A `stream` frame's body, the fields the relay forwards (`docs/hub.md`; frozen in the impl doc §B). */
export interface StreamFrame {
  /** The conversation this stream runs in. */
  cid: string
  /** The device running it. */
  from: string
  /** The turn's id: what tells two streams in one conversation apart. */
  round: string
  /** The batch's place in the round; a frame at or below the last one is a duplicate. */
  seq: number
  /** Grown text, appended to what the bubble holds. */
  delta?: string | undefined
  /** Grown reasoning, appended the same way. */
  reasoning?: string | undefined
  /** A step of the run: the tool it called, or what that tool returned. */
  tool?: { name: string; stage: 'call' | 'result'; summary?: string | undefined; ok?: boolean | undefined } | undefined
  /** This round is over; the bubble stops growing and its line comes down. */
  done: boolean
}

/** One tool step as the bubble shows it. */
export interface StreamTool {
  name: string
  stage: 'call' | 'result'
  summary: string
  ok: boolean
}

/** One turn in progress: the growing bubble for one `cid` + `round`. */
export interface StreamBucket {
  cid: string
  round: string
  /** The device running it, from the round's first frame. */
  from: string
  /** The highest `seq` merged so far; 0 before the first frame. */
  seq: number
  text: string
  reasoning: string
  tools: StreamTool[]
  done: boolean
  /** When the last frame arrived, so a quiet, unterminated round can be aged out. */
  at: number
}

/** Every stream of one conversation, by round. */
export type StreamBuckets = Record<string, StreamBucket>

/**
 * How long a round that went quiet is still worth drawing. A `stream` frame is fire and forget,
 * so a device that crashed mid-run, or a relay that dropped the last batch behind a `done`,
 * leaves a bucket nobody closes; past this its line is dropped rather than spinning under a
 * conversation that ended. Both ends read it: the host prunes its map by it, and the bubble
 * treats it as the bound past which a line it was handed is no longer live.
 */
export const STREAM_TTL_MS = 2 * 60_000

export interface StreamUpdate {
  /** The buckets as they stand: a new object when something changed, the same one when not. */
  buckets: StreamBuckets
  /** The round this frame touched, or `''` when the frame was dropped. */
  round: string
  /** Whether the frame changed anything; a dropped frame leaves the buckets identical. */
  changed: boolean
}

/** The key a round's bucket lives under. `cid` is in it so two chats cannot collide. */
export function streamKey(cid: string, round: string): string {
  return `${cid}\u0000${round}`
}

/**
 * Merge one frame into a conversation's streams. Pure: the same (buckets, frame) gives the same
 * answer, and the input object is never written to — a new one comes back when something changed.
 *
 * A frame is dropped when it names no conversation, is a duplicate (`seq` at or below the round's
 * last), or arrives after the round said it was done. `done` on a frame that also carries the last
 * batch is applied in the same step, so the final text is never lost to the ordering.
 */
export function applyStreamFrame(buckets: StreamBuckets, frame: StreamFrame, at = Date.now()): StreamUpdate {
  const cid = frame.cid.trim()
  const round = frame.round.trim()
  if (!cid || !round) return { buckets, round: '', changed: false }
  const key = streamKey(cid, round)
  const previous = buckets[key]
  if (previous && (previous.done || frame.seq <= previous.seq)) return { buckets, round, changed: false }

  // A frame that is only a close still has to reach the bubble, so a missing bucket is made here
  // rather than dropped: a `done` for a round whose opening batch was lost ends the line cleanly.
  const base: StreamBucket = previous ?? {
    cid,
    round,
    from: frame.from,
    seq: 0,
    text: '',
    reasoning: '',
    tools: [],
    done: false,
    at,
  }
  const batch: StreamBucket = {
    ...base,
    // The round keeps the device it opened with: `from` names whose run this is, and a relay that
    // forwarded a later batch from elsewhere must not re-label a bubble mid-flight.
    seq: Math.max(base.seq, frame.seq),
    text: frame.delta ? base.text + frame.delta : base.text,
    reasoning: frame.reasoning ? base.reasoning + frame.reasoning : base.reasoning,
    tools: frame.tool ? [...base.tools, toolOf(frame.tool)] : base.tools,
    done: frame.done === true,
    at,
  }
  return { buckets: { ...buckets, [key]: batch }, round, changed: true }
}

function toolOf(tool: NonNullable<StreamFrame['tool']>): StreamTool {
  return {
    name: tool.name.trim() || tool.name,
    stage: tool.stage,
    summary: (tool.summary ?? '').trim(),
    ok: tool.ok !== false,
  }
}

/**
 * A `stream` frame off the wire, or null when it is not one.
 *
 * The host hands frames over as plain JSON, the way `hub.ts` reads its own: every field is
 * unknown until checked, and a frame that is not a `stream` — or carries neither a conversation
 * nor a round, or nothing to draw at all — is left alone. That last part is the design's
 * "旧客户端不认识新帧时静默忽略" taken one step further: a newer relay's frame with a field this
 * build does not know is dropped here rather than half-drawn.
 *
 * A frame with only `done` is kept: it closes a round whose opening batch was lost.
 */
export function readStreamFrame(raw: unknown): StreamFrame | null {
  if (!raw || typeof raw !== 'object') return null
  const frame = raw as Record<string, unknown>
  if (frame['type'] !== 'stream') return null
  const cid = typeof frame['cid'] === 'string' ? frame['cid'].trim() : ''
  const round = typeof frame['round'] === 'string' ? frame['round'].trim() : ''
  if (!cid || !round) return null
  const seq = Number(frame['seq'])
  const delta = typeof frame['delta'] === 'string' ? frame['delta'] : undefined
  const reasoning = typeof frame['reasoning'] === 'string' ? frame['reasoning'] : undefined
  const tool = readTool(frame['tool'])
  const done = frame['done'] === true
  if (!delta && !reasoning && !tool && !done) return null
  return {
    cid,
    round,
    from: typeof frame['from'] === 'string' ? frame['from'] : '',
    seq: Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 0,
    delta,
    reasoning,
    tool,
    done,
  }
}

function readTool(raw: unknown): StreamFrame['tool'] {
  if (!raw || typeof raw !== 'object') return undefined
  const tool = raw as Record<string, unknown>
  const name = typeof tool['name'] === 'string' ? tool['name'].trim() : ''
  if (!name) return undefined
  const stage = tool['stage'] === 'result' ? 'result' : 'call'
  const summary = typeof tool['summary'] === 'string' ? tool['summary'] : undefined
  const ok = typeof tool['ok'] === 'boolean' ? tool['ok'] : undefined
  return { name, stage, summary, ok }
}

/** The round's bucket, or undefined when the conversation has no such stream. */
export function streamOf(buckets: StreamBuckets, cid: string, round: string): StreamBucket | undefined {
  return buckets[streamKey(cid, round)]
}

/** The conversation's streams, newest batch first: what the thread draws, in the order to read it. */
export function streamsOf(buckets: StreamBuckets, cid: string): StreamBucket[] {
  return Object.values(buckets)
    .filter((bucket) => bucket.cid === cid)
    .sort((a, b) => b.at - a.at || a.round.localeCompare(b.round))
}

/** The device a running stream is on, for the bubble's "from" line; null when it is this computer. */
export function streamDevice(bucket: StreamBucket, devices: readonly LiveDevice[], selfId: string): LiveDevice | null {
  if (bucket.from === '' || bucket.from === selfId) return null
  return devices.find((d) => d.id === bucket.from) ?? null
}

/**
 * The buckets still worth drawing: the running ones, and a finished round only while the final
 * text is on its way in the conversation (the design's "最终文本由 sync 兜底"): the bubble is
 * dropped the moment its reply arrives as an ordinary synced turn, which `settled` says.
 *
 * A round that went quiet without a `done` — the device crashed, the relay dropped the frames —
 * ages out after `ttlMs`, so a spinner cannot outlive the run it stood for.
 */
export function liveStreams(
  buckets: StreamBuckets,
  cid: string,
  options: { selfId: string; now?: number; ttlMs?: number; settled?: (bucket: StreamBucket) => boolean } = { selfId: '' },
): StreamBucket[] {
  const now = options.now ?? Date.now()
  const ttl = options.ttlMs ?? 15 * 60_000
  return streamsOf(buckets, cid).filter((bucket) => {
    if (options.settled?.(bucket)) return false
    return now - bucket.at < ttl
  })
}

/** Drop every round of a conversation that has been settled or has gone quiet (see `liveStreams`). */
export function pruneStreams(
  buckets: StreamBuckets,
  options: { now?: number; ttlMs?: number; settled?: (bucket: StreamBucket) => boolean } = {},
): StreamBuckets {
  const now = options.now ?? Date.now()
  const ttl = options.ttlMs ?? 15 * 60_000
  const kept = Object.entries(buckets).filter(([, bucket]) => !options.settled?.(bucket) && now - bucket.at < ttl)
  if (kept.length === Object.keys(buckets).length) return buckets
  return Object.fromEntries(kept)
}
