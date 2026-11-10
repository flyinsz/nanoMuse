/**
 * `@<device name>` at the start of a message hands the turn to that device (contract C7
 * rule 8). The runtime does the real parsing; this is the composer's half — the names to
 * offer while the mention is being typed, and the device a finished mention points at, so
 * the box can say where the message goes before it is sent.
 *
 * `@本机` names *this* console (executor handoff v2 §4.2 rule 3): it is how a line comes back
 * from a device the turn was handed to. The hub never lists the device that is asking, so
 * the row is synthesised here from the console's own identity and put first — the way back
 * must not depend on the account listing this browser, and the runtime's own list of
 * self-words (`nanomuse/sync/mention.py`) reads the same two words.
 */
import type { HubDevice } from "./types";

/** The words that name this device on their own, one per locale the UI writes in. */
export const SELF_WORDS = ["本机", "This machine", "This device"];

/** The row the composer offers for this device itself, `@本机` and all. */
export interface MentionChoice {
  id: string;
  name: string;
  online: boolean;
  /** true for the synthesised this-device row, which has no hub entry behind it */
  self?: boolean;
}

/** the devices a message can be addressed to: not this one, not a browser tab */
export function mentionable(devices: HubDevice[]): HubDevice[] {
  return devices.filter((d) => !d.this && d.kind !== "web" && d.name.trim() !== "");
}

/**
 * What the `@` menu offers: this device first, then the account's other devices whose names
 * match. [selfLabel] is the localised name for this device (`@本机`); blank leaves it out (a
 * signed-out console has no device to name).
 */
export function mentionChoices(
  text: string,
  devices: HubDevice[],
  selfLabel = "",
  limit = 6,
): MentionChoice[] {
  const prefix = mentionPrefix(text);
  if (prefix === null) return [];
  const p = prefix.toLowerCase();
  const selfRow: MentionChoice[] = [];
  const label = selfLabel.trim().replace(/^@/, "");
  if (label && label.toLowerCase().startsWith(p)) {
    selfRow.push({ id: "", name: label, online: true, self: true });
  }
  const others: MentionChoice[] = mentionable(devices)
    .filter((d) => d.name.toLowerCase().startsWith(p))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
    .map((d) => ({ id: d.id, name: d.name, online: d.online }));
  return [...selfRow, ...others].slice(0, limit);
}

/** What is being typed after a leading `@` and before the first space, or null when the text is not a mention in progress. */
export function mentionPrefix(text: string): string | null {
  const m = /^@([^\s,:;，：；]*)$/.exec(text);
  return m ? m[1] : null;
}

/** The devices whose names start with what was typed so far (case-insensitive), the online ones first. */
export function mentionSuggestions(text: string, devices: HubDevice[], limit = 6): HubDevice[] {
  const prefix = mentionPrefix(text);
  if (prefix === null) return [];
  const p = prefix.toLowerCase();
  return mentionable(devices)
    .filter((d) => d.name.toLowerCase().startsWith(p))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * The device a message starting with `@` names, the way the runtime will read it: the whole
 * name at the start (longest first), else the first word as the prefix of exactly one name
 * (of exactly one online device when several match). Null when nothing is addressed.
 */
export function mentionTarget(text: string, devices: HubDevice[]): HubDevice | null {
  const body = text.trimStart();
  if (!body.startsWith("@")) return null;
  const rest = body.slice(1);
  const lower = rest.toLowerCase();
  const others = mentionable(devices);
  const whole = others
    .filter((d) => {
      const name = d.name.trim().toLowerCase();
      if (!lower.startsWith(name)) return false;
      const after = rest.charAt(name.length);
      return after === "" || /[\s,:;，：；]/.test(after);
    })
    .sort((a, b) => b.name.length - a.name.length);
  if (whole[0]) return whole[0];
  const word = /^[^\s,:;，：；]+/.exec(rest)?.[0]?.toLowerCase() ?? "";
  if (!word) return null;
  const hits = others.filter((d) => d.name.trim().toLowerCase().startsWith(word));
  if (hits.length === 1) return hits[0];
  const online = hits.filter((d) => d.online);
  return online.length === 1 ? online[0] : null;
}
