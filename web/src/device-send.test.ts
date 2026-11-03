import { describe, expect, it } from "vitest";
import { directTarget, stripMention } from "./device-send";
import type { HubDevice } from "./types";

/**
 * Where an `@<device>` message goes, and what is left to say to that device. The reading is
 * the runtime's (`nanomuse/sync/mention.py`, by way of `mentionTarget`), so these cases are
 * the same ones the phone and the desktop are checked against.
 */
const devices: HubDevice[] = [
  { id: "me", name: "Desk", kind: "computer", online: true, this: true },
  { id: "tab", name: "Chrome", kind: "web", online: true },
  { id: "mac-1", name: "Mac mini", kind: "computer", online: true },
  { id: "mac-2", name: "MacBook Pro", kind: "computer", online: true },
  { id: "ph-1", name: "Pixel 8", kind: "phone", online: true },
  { id: "off-1", name: "Old Laptop", kind: "computer", online: false },
];

describe("directTarget", () => {
  it("takes the whole name and leaves the task", () => {
    expect(directTarget("@Pixel 8 open the calendar", devices)).toEqual({
      device: devices[4],
      text: "open the calendar",
    });
  });

  it("cuts the separator that follows the name", () => {
    for (const mark of [":", ",", "，", "："]) {
      expect(directTarget(`@Mac mini${mark} restart`, devices)?.text).toBe("restart");
    }
  });

  it("prefers the longest name that matches", () => {
    expect(directTarget("@MacBook Pro run the tests", devices)?.device.name).toBe("MacBook Pro");
    expect(directTarget("@Mac mini restart", devices)?.device.name).toBe("Mac mini");
  });

  it("is not a mention when nothing after it is said", () => {
    // an empty task is not a task: it would open a chat and send nothing
    expect(directTarget("@Mac mini", devices)).toBeNull();
    expect(directTarget("@Mac mini   ", devices)).toBeNull();
    expect(directTarget("@Mac mini:", devices)).toBeNull();
  });

  it("leaves an offline device to the ordinary path", () => {
    expect(directTarget("@Old Laptop do the thing", devices)).toBeNull();
  });

  it("never addresses this device or a browser tab", () => {
    expect(directTarget("@Desk do the thing", devices)).toBeNull();
    expect(directTarget("@Chrome do the thing", devices)).toBeNull();
  });

  it("is not a mention when the message does not open with @", () => {
    expect(directTarget("ask Mac mini to restart", devices)).toBeNull();
    expect(directTarget("hi @Mac mini restart", devices)).toBeNull();
  });
});

describe("stripMention", () => {
  it("cuts a prefix of the name as far as what was typed", () => {
    // "@mac …" matched "Mac mini" by its start, so only the typed word comes off
    expect(stripMention("@mac restart", devices[2])).toBe("restart");
  });

  it("keeps the rest of the words as they were typed", () => {
    expect(stripMention("@Pixel 8   take   a screenshot  ", devices[4])).toBe("take   a screenshot");
  });
});
