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

/** The row as the header draws it: the face in the middle, and the ones on either side of it. */
export interface FaceRow {
  /** The device whose chat is open, or null when the chat goes nowhere in particular. */
  middle: DeviceFace | null;
  left: DeviceFace[];
  right: DeviceFace[];
}

/**
 * Every Muse of the account, in the order the row draws them: the one whose chat is open first,
 * then the online ones by name, then the sleeping ones.
 *
 * The device this runtime runs on is among them (the relay marks it `this`), and so is the
 * browser page itself when signed in as the same account: the row is the account's Muses, and
 * the one whose chat is open is one of them rather than a special case beside them. Picking it
 * is how a chat goes back to being this device's own.
 *
 * Browser *tabs* are left out (nothing there to talk to), and so is a nameless entry.
 */
export function muses(
  devices: readonly HubDevice[],
  opts: { chatDevice?: string; threads?: readonly { id: string; device?: string }[] } = {},
): DeviceFace[] {
  const chatDevice = opts.chatDevice ?? "";
  const threads = opts.threads ?? [];
  const threadOf = (d: HubDevice): string | null => threads.find((t) => t.device === d.id)?.id ?? null;
  return devices
    .filter((d) => d.kind !== "web" && d.name.trim() !== "")
    .sort((a, b) => {
      const fa = a.id === chatDevice ? 0 : 1;
      const fb = b.id === chatDevice ? 0 : 1;
      if (fa !== fb) return fa - fb;
      // this device first among the rest: it is the one being held
      if (!!a.this !== !!b.this) return a.this ? -1 : 1;
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((device) => ({ device, thread: threadOf(device) }));
}

/**
 * The row split around the middle face: the one whose chat is open, and the rest by count, the
 * first half to the left and the rest to the right.
 *
 * The split is by count so the two sides are of like width and the middle face stays in the
 * middle of the bar; nothing about the devices decides it. When the chat goes nowhere in
 * particular (the main chat, a side chat) there is no middle face and every device is on the
 * sides, which is the honest drawing: nothing is open, so nothing is enlarged.
 */
export function faceRow(
  devices: readonly HubDevice[],
  opts: { chatDevice?: string; threads?: readonly { id: string; device?: string }[] } = {},
): FaceRow {
  const everyone = muses(devices, opts);
  // the chat's own device, or this device when the chat goes nowhere in particular: a chat with
  // no device open is this device's own chat, so its face is the one in the middle
  const middle =
    everyone.find((f) => f.device.id === (opts.chatDevice ?? "")) ??
    everyone.find((f) => f.device.this) ??
    null;
  const rest = everyone.filter((f) => f.device.id !== middle?.device.id);
  const half = Math.ceil(rest.length / 2);
  return { middle, left: rest.slice(0, half), right: rest.slice(half) };
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
