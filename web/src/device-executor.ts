/**
 * Who a chat's next line runs on (the executor), as the composer's placeholder names it: the
 * owner the runtime reports on the conversation row when it has one, else the device the chat
 * was addressed to, else this device. Pure, so the composer and the tests share one rule.
 */
import { deviceNameOf } from "./stream-buckets";
import type { HubDevice, ThreadMeta } from "./types";

/**
 * Which device runs a chat's next turn, and what it is called. `here: true` is this device
 * (a local chat carries no device id of its own); otherwise `name` is the other device's
 * display name. An unnamed device falls back to its id.
 *
 * `selfId` is this browser session's own hub device id. The runtime sends the owner on every
 * thread row, and the owner may well be *this* console — a line typed here makes the console
 * the owner, and the composer should then say so rather than naming itself as a third party.
 * Without the comparison the placeholder read "this device" for an owner it could not
 * recognise, which hid the very case it exists to show (the console is the owner).
 */
export function executorOf(
  thread: ThreadMeta | undefined,
  devices: readonly HubDevice[] = [],
  selfId = "",
): { here: boolean; name: string } {
  const id = (thread?.owner_device || thread?.device || "").trim();
  if (!id) return { here: true, name: "" };
  if (selfId && id === selfId) return { here: true, name: "" };
  const reported = (thread?.owner_device_name || "").trim();
  return { here: false, name: reported || deviceNameOf(id, devices) };
}
