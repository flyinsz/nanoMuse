/**
 * The deltas of replies being written right now, as the store keeps them (contract C13).
 *
 * A stream used to be keyed by conversation alone, so two runs in the same conversation —
 * one here, one handed to another device — overwrote each other. The relay's new `stream`
 * frame carries a `round` (the id of that turn), so a bucket is keyed by conversation *and*
 * round, and two streams in one conversation no longer collide.
 *
 * Frames from an older runtime carry no `round`: they keep the old behaviour exactly, one
 * bucket per conversation. Pure, so the store stays thin and the rule can be pinned by tests.
 */

export interface Stream {
  id: string;
  text: string;
  /** live reasoning, streamed this turn only; the final event carries the fold */
  reasoning: string;
  ended: boolean;
  /** the run this stream belongs to; absent on frames from a runtime older than the round id */
  round?: string;
}

/** Stream buckets by key; see `bucketKey`. A `undefined` value is an emptied bucket. */
export type StreamBuckets = Record<string, Stream | undefined>;

const SEP = "\u0000";

/**
 * Where a stream lives: the conversation, plus the round when the frame names one. A frame
 * without a round lands in the conversation's own bucket, which is what the app did before
 * rounds existed — so an older runtime keeps working unchanged.
 */
export function bucketKey(thread: string, round?: string): string {
  return round ? `${thread}${SEP}${round}` : thread;
}

/**
 * `stream_start`: a fresh, empty bucket for this stream. A later `stream_start` for the same
 * round starts over, as one bucket has always started over.
 */
export function startStream(buckets: StreamBuckets, thread: string, id: string, round?: string): StreamBuckets {
  return { ...buckets, [bucketKey(thread, round)]: { id, text: "", reasoning: "", ended: false, round } };
}

/**
 * A `delta`: the text appends to the open stream of this round; a delta whose id does not
 * match the open one (or that arrives with no stream started) opens the stream with this
 * chunk, which is what the old per-conversation code did.
 */
export function appendText(buckets: StreamBuckets, thread: string, id: string, text: string, round?: string): StreamBuckets {
  const key = bucketKey(thread, round);
  const current = buckets[key];
  const stream: Stream = current && current.id === id ? { ...current, text: current.text + text } : { id, text, reasoning: "", ended: false, round };
  return { ...buckets, [key]: stream };
}

/** A `reasoning_delta`: the same rule as `appendText`, into the reasoning side of the stream. */
export function appendReasoning(buckets: StreamBuckets, thread: string, id: string, text: string, round?: string): StreamBuckets {
  const key = bucketKey(thread, round);
  const current = buckets[key];
  const stream: Stream = current && current.id === id ? { ...current, reasoning: current.reasoning + text } : { id, text: "", reasoning: text, ended: false, round };
  return { ...buckets, [key]: stream };
}

/**
 * A `stream_end`: keep the text until the persisted reply replaces it (avoids flicker); an
 * empty stream, or one the server says was not a reply, goes right away. A stream_end for a
 * round with nothing (or a different stream) in its bucket changes nothing.
 */
export function endStream(buckets: StreamBuckets, thread: string, id: string, discard?: boolean, round?: string): StreamBuckets {
  const key = bucketKey(thread, round);
  const current = buckets[key];
  if (!current || current.id !== id) return buckets;
  if (discard || !current.text.trim()) return { ...buckets, [key]: undefined };
  return { ...buckets, [key]: { ...current, ended: true } };
}

/**
 * The reply that this stream was filling has landed as a persisted event (the same id): its
 * bucket goes. Only this conversation's buckets are looked at; one whose id matches in any
 * round is dropped, which for an older runtime (one bucket per conversation) is the old rule.
 */
export function dropStreamById(buckets: StreamBuckets, thread: string, id: string): StreamBuckets {
  let next: StreamBuckets | null = null;
  for (const key of threadKeys(buckets, thread)) {
    if (buckets[key]?.id !== id) continue;
    next = next ?? { ...buckets };
    next[key] = undefined;
  }
  return next ?? buckets;
}

/** The run went idle: every finished stream of this conversation can go (the reply has landed). */
export function dropEndedStreams(buckets: StreamBuckets, thread: string): StreamBuckets {
  let next: StreamBuckets | null = null;
  for (const key of threadKeys(buckets, thread)) {
    if (!buckets[key]?.ended) continue;
    next = next ?? { ...buckets };
    next[key] = undefined;
  }
  return next ?? buckets;
}

/** The live streams of one conversation, in the order they opened. */
export function streamsForThread(buckets: StreamBuckets, thread: string): Stream[] {
  const out: Stream[] = [];
  for (const key of threadKeys(buckets, thread)) {
    const s = buckets[key];
    if (s) out.push(s);
  }
  return out;
}

/** The keys of one conversation: its own bucket, then any per-round buckets that follow. */
function threadKeys(buckets: StreamBuckets, thread: string): string[] {
  const prefix = `${thread}${SEP}`;
  return Object.keys(buckets).filter((k) => k === thread || k.startsWith(prefix));
}
