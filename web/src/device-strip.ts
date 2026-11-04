/**
 * The account's Muses as the header draws them: one face per device, the one whose chat is open
 * large in the middle of the bar and the rest small on either side of it. A tap on any of them
 * opens that Muse's chat (see `device-send.ts` for what a mention does; this is the same trip,
 * taken by hand).
 *
 * Why the header and not over the composer: the face is where the app already says whose chat
 * this is, and the other Muses of the account belong with it, in one glance and one tap. A row
 * over the box also reads as part of the message being written, which it is not.
 *
 * Every device wears the same face, which is the account's own rule rather than a shortcut here:
 * the profile (name, avatar, emoji, colour) is one per account and every device wears it
 * (nanomuse/server/service.py, `hub.profile.changed`), so a device has no face of its own to
 * draw. What tells them apart is what the person knows them by: the size (whose chat is open)
 * and the name under each face.
 *
 * The decisions live here, apart from the views, so both clients answer the same way and the
 * rules can be checked without a renderer.
 */
import type { HubDevice } from "./types";

/** One face of the row: which device, and the chat it already has (a tap returns to it). */
export interface DeviceFace {
  device: HubDevice;
  /** The chat addressed to this device when one exists, so a tap returns to it. */
  thread: string | null;
}

/**
 * Every Muse of the account, in the order the row holds them: this device first, then the online
 * ones by name, then the sleeping ones.
 *
 * The order is the same whatever chat is open, and that is the point of it. The row is a window
 * on a longer strip that rolls sideways, so where a face sits in it is what makes the roll
 * visible: an order that answered "whose chat is open" would put that face at one end every
 * time, the window would never have to move, and a tap would look like the row rearranging
 * itself rather than the strip being turned. The phone draws the same order for the same reason
 * (`DeviceStrip.muses`), so a pick rolls the same way on both.
 *
 * The device this runtime runs on is among them (the relay marks it `this`): the row is the
 * account's Muses, and the one being held is one of them rather than a special case beside them.
 * Picking it is how a chat goes back to being this device's own.
 *
 * Browser *tabs* are left out (nothing there to talk to), and so is a nameless entry.
 */
export function muses(
  devices: readonly HubDevice[],
  opts: { chatDevice?: string; threads?: readonly { id: string; device?: string }[] } = {},
): DeviceFace[] {
  const threads = opts.threads ?? [];
  const threadOf = (d: HubDevice): string | null => threads.find((t) => t.device === d.id)?.id ?? null;
  return devices
    .filter((d) => d.kind !== "web" && d.name.trim() !== "")
    .slice()
    .sort((a, b) => {
      // this device first: it is the one being held
      if (!!a.this !== !!b.this) return a.this ? -1 : 1;
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((device) => ({ device, thread: threadOf(device) }));
}

/**
 * The face the row draws large in the middle: the device the open chat is addressed to, or — when
 * the chat goes nowhere in particular (the main chat, a side chat) — this device, since a chat
 * with no device open is this device's own. Null only when the account has no device at all.
 *
 * This is the face the strip rolls to, so it is the one decision the roll depends on; it lives
 * here rather than in the view so it can be checked without a renderer.
 */
export function focusedFace(
  devices: readonly HubDevice[],
  opts: { chatDevice?: string; threads?: readonly { id: string; device?: string }[] } = {},
): DeviceFace | null {
  const everyone = muses(devices, opts);
  return (
    everyone.find((f) => f.device.id === (opts.chatDevice ?? "")) ??
    everyone.find((f) => f.device.this) ??
    null
  );
}

/**
 * Whether a device's chat holds a reply the person has not looked at yet, from the chat's own
 * last-write time and the last time that chat was open here.
 *
 * A device's chat is a place replies arrive while nobody is looking at it — the whole point of
 * walking away from it — so the strip is where "there is something to read there" has to be
 * said, or the only way to learn it is to open each one in turn. `updated_at` and the remembered
 * moment are both the runtime's own ISO strings, so comparing them as text is comparing them as
 * times.
 */
export function hasNews(
  thread: { updated_at?: string } | undefined | null,
  seenAt: string | undefined,
): boolean {
  const at = thread?.updated_at;
  if (!at) return false;
  return !seenAt || at > seenAt;
}

/**
 * The chat this device's own face opens: the most recently written of the chats that *arrived*
 * from another device, when one of them holds something unread, or null for the main chat.
 *
 * A task another device hands this device runs in a chat of its own, and the runtime marks it
 * `remote_from` (a chat another device opened here with a `task`). It belongs to no device's face —
 * the faces are the account's devices, and a chat that came *from* one is not a chat *with* one —
 * so this device's own face is the only place that can say "another device sent you something",
 * and the only thing a tap on it can open.
 *
 * "Most recently written" rather than "oldest": the newest arrival is the one a person picking up
 * their phone is looking for, and reading it leaves the older ones for the next tap. With none
 * unread the face means the main chat again, which is its usual meaning.
 *
 * `updated_at` and the remembered moment are the runtime's own ISO strings, so comparing them as
 * text is comparing them as times — the same comparison `hasNews` makes for a device's chat.
 */
export function newestUnreadIncoming(
  threads: readonly { id: string; updated_at?: string; remote_from?: unknown }[],
  seenAt: Record<string, string | undefined>,
): string | null {
  let best: string | null = null;
  let bestAt = "";
  for (const th of threads) {
    if (!th.remote_from) continue;
    const at = th.updated_at;
    if (!hasNews(th, seenAt[th.id])) continue;
    if (best === null || (at ?? "") > bestAt) {
      best = th.id;
      bestAt = at ?? "";
    }
  }
  return best;
}

/**
 * How far the strip must scroll to put a face in the middle of its box, from measurements the
 * caller takes.
 *
 * The layout is not consulted, and neither is `offsetLeft`: the strip is a flex row, which does
 * not establish an offset parent, so `offsetLeft` is measured from something outside it and the
 * answer drifts with the page. Every box here is what `getBoundingClientRect` reports, so the
 * same numbers come back in any browser and in a test with nothing rendered.
 *
 * - `boxLeft` / `boxWidth` — the scroll box, on screen and its visible width (`clientWidth`).
 * - `faceLeft` / `faceWidth` — the face to centre, likewise. Both rectangles include the box's
 *   current scroll, which is why it is taken back out below.
 * - `scrollLeft` — the box's current scroll, so the face's place in the *content* can be had
 *   rather than where it happens to sit on screen right now.
 *
 * The clamp is what the element's own `scrollTo` would do anyway; doing it here keeps the return
 * value honest (a test can say "this rolls to the end" and mean it) and keeps the first fit from
 * asking for a negative scroll.
 */
export function centringScroll(input: {
  boxLeft: number;
  boxWidth: number;
  faceLeft: number;
  faceWidth: number;
  scrollLeft: number;
  contentWidth: number;
}): number {
  const { boxLeft, boxWidth, faceLeft, faceWidth, scrollLeft, contentWidth } = input;
  // the box's left edge measures where the *content* is scrolled to, so taking the scroll back
  // out gives the face's own place in the content, on screen or not
  const contentStart = boxLeft - scrollLeft;
  const faceOffset = faceLeft - contentStart;
  const wanted = faceOffset - (boxWidth - faceWidth) / 2;
  const max = Math.max(0, contentWidth - boxWidth);
  return Math.min(Math.max(wanted, 0), max);
}
