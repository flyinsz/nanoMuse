/**
 * The device strip above the composer: one avatar per device of the account, the one the open
 * chat is addressed to drawn larger than the rest, and a tap on another opens (or returns to)
 * that device's chat.
 *
 * Why a strip and not only `@<device>`: the mention is a reading of what was typed, so it can
 * only offer a device whose name the person already knows and can spell, and on a phone that is
 * the whole cost of the feature (Android's picker lists files only, so the name has to be typed
 * by hand). A row of the account's devices says who is reachable at a glance, in one tap,
 * without knowing a name.
 *
 * A tap does what `device-send.ts` already does for a mention: open the chat with that device
 * (`POST /api/hub/ask`) and land in it. The runtime makes one chat per device and hands the
 * same one back, so a device already talked to is returned to rather than opened twice, and
 * nothing here changes a chat's target (the runtime has no such operation: a chat's `device` is
 * set when it is made and never moves).
 *
 * The decisions live here, apart from the views, so all three clients answer the same way and
 * the rules can be checked without a renderer.
 */
import type { HubDevice } from "./types";

/** One device as the strip shows it: which to draw, and where a tap lands. */
export interface DeviceChip {
  device: HubDevice;
  /** The chat addressed to this device when one exists, so a tap returns to it. */
  thread: string | null;
  /** Whether this is the device the open chat is addressed to (the enlarged avatar). */
  focused: boolean;
}

/**
 * The devices the strip lists, in the order it draws them: the one the open chat is addressed to
 * first (it is the enlarged one, and should not move as the person switches chats), then the
 * online ones by name, then the offline ones by name.
 *
 * Offline devices are kept and greyed rather than hidden: a device that is merely asleep is
 * still one of the person's, and seeing it there is how they know a task to it would not go.
 * The browser this page is open in is left out (no hub socket to answer on), as is the device
 * this runtime runs on (a chat addressed to it would be this chat).
 */
export function deviceStrip(
  devices: readonly HubDevice[],
  opts: { chatDevice?: string; threads?: readonly { id: string; device?: string }[]; locale?: string } = {},
): DeviceChip[] {
  const chatDevice = opts.chatDevice ?? "";
  const threads = opts.threads ?? [];
  const threadOf = (device: HubDevice): string | null =>
    threads.find((t) => t.device === device.id)?.id ?? null;

  return devices
    .filter((d) => !d.this && d.kind !== "web" && d.name.trim() !== "")
    .sort((a, b) => {
      const fa = a.id === chatDevice ? 0 : 1;
      const fb = b.id === chatDevice ? 0 : 1;
      if (fa !== fb) return fa - fb;
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.name.localeCompare(b.name, opts.locale ?? undefined);
    })
    .map((device) => ({ device, thread: threadOf(device), focused: device.id === chatDevice }));
}
