/**
 * `@<device>` at the start of a message, sent straight to that device (docs/local/P1-CONTRACT.md):
 * the chat with that device is opened and the words go into it, so the task runs there without
 * a turn of this device's agent handing it over. A browser has no hub socket of its own; the
 * runtime's REST API is the way over (`POST /api/hub/ask` opens the chat, `send` starts the run).
 */
import { api } from "./api";
import { getLocale } from "./i18n";
import { mentionTarget } from "./mention";
import type { HubDevice, ThreadMeta } from "./types";

/** A message that goes straight to another device: which one, and what is left to say to it. */
export interface DeviceSend {
  device: HubDevice;
  /** the words after the mention, already cut off it */
  text: string;
}

/**
 * Where a message goes when it starts with `@`, or null for the ordinary path: nothing named,
 * the named device offline (the agent hands that one over instead), or nothing said after the
 * mention (which would be an empty task over the hub).
 */
export function directTarget(text: string, devices: HubDevice[]): DeviceSend | null {
  const body = text.trim();
  const device = mentionTarget(body, devices);
  if (device === null || !device.online) return null;
  const rest = stripMention(body, device);
  return rest ? { device, text: rest } : null;
}

/**
 * The words after the mention, cut the way the runtime cuts them: the whole name when the
 * whole name is what matched, else the first word as the starting of the name, and then the
 * spaces and separators that follow.
 */
export function stripMention(text: string, device: HubDevice): string {
  const rest = text.trim().slice(1);
  const name = device.name.trim();
  const after = rest.charAt(name.length);
  const whole = rest.toLowerCase().startsWith(name.toLowerCase()) && (after === "" || /[\s,:;，：；]/.test(after));
  const cut = whole ? name.length : (/^[^\s,:;，：；]+/.exec(rest)?.[0]?.length ?? 0);
  return rest.slice(cut).replace(/^[\s,:;，：；]+/, "");
}

/**
 * Opens the chat with that device (the runtime makes one per device) and sends the message into
 * it, in the language of these screens, so the device answers in the language the person reads.
 * `onThread` hears about the chat as soon as it exists: the person lands in it even when the
 * message after it is refused. Rejects with the runtime's own sentence, which is worth showing.
 */
export async function sendToDevice(
  device: HubDevice,
  text: string,
  onThread: (thread: ThreadMeta) => void,
): Promise<void> {
  const { thread } = await api.askDevice(device.id);
  onThread(thread);
  const sent = await api.send(thread.id, text, [], getLocale());
  onThread(sent.thread);
}