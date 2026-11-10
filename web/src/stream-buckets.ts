/**
 * A run drawn *here* that is not this device's own: another device of the account is writing a
 * turn of a conversation this page shows (contract C7). The runtime turns the relay's `stream`
 * frame into the very bus frames a local run produces — `stream_start` / `delta` /
 * `reasoning_delta` / `tool_delta` / `stream_end` — each carrying `remote: true` and an `id` of
 * `{round}:{device}`. Those would otherwise land in `streams[thread]` and overwrite a local run
 * of the same chat, so they go into their own buckets, one per `id`. Pure, so the store and the
 * chat screen share one rule and the tests can pin it.
 */
import type { HubDevice } from "./types";

/**
 * A run another device is drawing, as far as this page has heard. The relay never replays a
 * stream, so this is a screen hint: the run's final text still arrives over sync and replaces
 * it.
 */
export interface DeviceStream {
  /** the bus frame's own id: `{round}:{device}`, one bucket per run */
  id: string;
  /** the chat it belongs to (the runtime's thread) */
  conv: string;
  /** the device running it, read off the id, for naming it on screen */
  device: string;
  /** how the relay names that device, when the frame carried it */
  deviceName: string;
  text: string;
  /** live reasoning of the run; the final event still carries the fold */
  reasoning: string;
  /** the last step the run reported */
  tool: { name: string; stage: string } | null;
  /** the run said it was done; the synced reply takes over from here */
  ended: boolean;
  /** when the last batch arrived, for the freshness rule */
  at: number;
}

/** A run whose last batch is older than this is dropped: the device went away mid-turn. */
export const DEVICE_STREAM_TTL_MS = 15 * 60 * 1000;

/** One batch, from either entry point: a remote bus frame, or the relay's `stream` frame. */
export interface StreamPart {
  /** `{round}:{device}` */
  id: string;
  /** the runtime's thread */
  conv: string;
  deviceName?: string;
  delta?: string;
  reasoning?: string;
  tool?: { name?: string; stage?: string } | null;
  done?: boolean;
}

/** The device half of a bus id (`{round}:{device}`); "" when the id has no device in it. */
export function deviceOfId(id: string): string {
  const cut = id.lastIndexOf(":");
  return cut < 0 ? "" : id.slice(cut + 1);
}

/** The display name of a device id, from the hub's list; the id itself when unknown. */
export function deviceNameOf(id: string, devices: readonly HubDevice[] = []): string {
  const d = devices.find((x) => x.id === id);
  return (d?.name || "").trim() || id;
}

/**
 * One bucket per run. The runtime's id (`{round}:{device}`) is unique per run, but a chat is
 * added to the key anyway so a frame that names a chat and an id already used by another chat
 * cannot append into the wrong one. Joined on a character ids cannot hold.
 */
export function streamKey(conv: string, id: string): string {
  return `${conv}\u0000${id}`;
}

/** Runs that went quiet are let go as new batches arrive, so the map stays small. */
function prune(
  buckets: Record<string, DeviceStream | undefined>,
  now: number,
  keep: string,
): Record<string, DeviceStream | undefined> {
  let out: Record<string, DeviceStream | undefined> | null = null;
  for (const [key, s] of Object.entries(buckets)) {
    if (!s || key === keep) continue;
    if (now - s.at >= DEVICE_STREAM_TTL_MS) {
      out = out ?? { ...buckets };
      out[key] = undefined;
    }
  }
  return out ?? buckets;
}

/**
 * One batch of a run on another device, into its bucket (`id`). `done` closes the run; a run
 * this page never drew is not opened by it. A batch for a run already closed is dropped, or the
 * run would come back to life after its `stream_end`.
 */
export function applyStreamPart(
  buckets: Record<string, DeviceStream | undefined>,
  part: StreamPart,
  now = Date.now(),
): Record<string, DeviceStream | undefined> {
  const id = part.id.trim();
  const conv = part.conv.trim();
  if (!id || !conv) return buckets;
  const key = streamKey(conv, id);
  const prev = buckets[key];
  const tool = part.tool && (part.tool.name || part.tool.stage) ? part.tool : null;
  const carries = !!(part.delta || part.reasoning || tool);
  if (!prev && !carries && !part.done) return buckets;
  if (part.done) {
    if (!prev) return buckets;
    return { ...prune(buckets, now, key), [key]: { ...prev, ended: true, at: now } };
  }
  if (prev?.ended) return buckets;
  const next: DeviceStream = {
    id,
    conv,
    device: prev?.device || deviceOfId(id),
    deviceName: part.deviceName?.trim() || (prev?.deviceName ?? ""),
    text: (prev?.text ?? "") + (part.delta ?? ""),
    reasoning: (prev?.reasoning ?? "") + (part.reasoning ?? ""),
    tool: tool ? { name: String(tool.name ?? ""), stage: String(tool.stage ?? "") } : (prev?.tool ?? null),
    ended: false,
    at: now,
  };
  return { ...prune(buckets, now, key), [key]: next };
}

/** A run starts: the bucket is opened empty, ready for the batches behind it. */
export function startStreamPart(
  buckets: Record<string, DeviceStream | undefined>,
  part: Pick<StreamPart, "id" | "conv" | "deviceName">,
  now = Date.now(),
): Record<string, DeviceStream | undefined> {
  const id = part.id.trim();
  const conv = part.conv.trim();
  if (!id || !conv) return buckets;
  const key = streamKey(conv, id);
  const prev = buckets[key];
  if (prev) return buckets;
  const next: DeviceStream = {
    id,
    conv,
    device: deviceOfId(id),
    deviceName: part.deviceName?.trim() ?? "",
    text: "",
    reasoning: "",
    tool: null,
    ended: false,
    at: now,
  };
  return { ...prune(buckets, now, key), [key]: next };
}

/**
 * The run to draw for a chat: a live run beats a closed one (the closed run's reply is already
 * on its way over sync, and the live run is what is happening now); among equals the newest
 * wins. A closed run is still returned when nothing is live — kept until the synced reply
 * replaces it the way a local stream is, so the bubble does not blink out a frame early. A run
 * that went quiet past the TTL is left out.
 */
export function streamForConversation(
  buckets: Record<string, DeviceStream | undefined>,
  conv: string,
  now = Date.now(),
): DeviceStream | undefined {
  let best: DeviceStream | undefined;
  for (const s of Object.values(buckets)) {
    if (!s || s.conv !== conv) continue;
    if (now - s.at >= DEVICE_STREAM_TTL_MS) continue;
    if (!best) {
      best = s;
      continue;
    }
    if (best.ended !== s.ended) {
      if (best.ended) best = s;
      continue;
    }
    if (s.at >= best.at) best = s;
  }
  return best;
}

/** Every run of a chat, for when the chat itself goes (cleared or deleted). */
export function dropConversation(
  buckets: Record<string, DeviceStream | undefined>,
  conv: string,
): Record<string, DeviceStream | undefined> {
  let out: Record<string, DeviceStream | undefined> | null = null;
  for (const [key, s] of Object.entries(buckets)) {
    if (!s || s.conv !== conv) continue;
    out = out ?? { ...buckets };
    out[key] = undefined;
  }
  return out ?? buckets;
}

/**
 * A reply landed over sync, so the run that was drawing it goes — the same moment a local
 * stream is cleared. Ended runs always go. `synced` says the reply came from another device
 * (contract C9): that is the very reply a remote run was drawing, so a run still marked live
 * goes too, in case the relay's final `stream_end` lost the race with sync. A batch arriving
 * afterwards re-opens nothing (`applyStreamPart`), and the next run gets a new id.
 */
export function settleConversation(
  buckets: Record<string, DeviceStream | undefined>,
  conv: string,
  synced = false,
): Record<string, DeviceStream | undefined> {
  let out: Record<string, DeviceStream | undefined> | null = null;
  for (const [key, s] of Object.entries(buckets)) {
    if (!s || s.conv !== conv) continue;
    if (!s.ended && !synced) continue;
    out = out ?? { ...buckets };
    out[key] = undefined;
  }
  return out ?? buckets;
}
