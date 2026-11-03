import { describe, expect, it } from "vitest";
import { deviceStrip } from "./device-strip";
import type { HubDevice } from "./types";

/**
 * Which devices the strip above the composer shows, in what order, and which one is enlarged.
 * The rules all three clients share: the open chat's device first and enlarged, then the online
 * ones, then the offline ones greyed, with nothing that cannot answer a task on it.
 */
const devices: HubDevice[] = [
  { id: "me", name: "Desk", kind: "computer", online: true, this: true },
  { id: "tab", name: "Chrome", kind: "web", online: true },
  { id: "mac-1", name: "Mac mini", kind: "computer", online: true },
  { id: "srv-1", name: "服务器", kind: "computer", online: true },
  { id: "ph-1", name: "Pixel 8", kind: "phone", online: true },
  { id: "off-1", name: "Old Laptop", kind: "computer", online: false },
];

describe("deviceStrip", () => {
  it("leaves out this device and the browser", () => {
    const ids = deviceStrip(devices).map((c) => c.device.id);
    expect(ids).not.toContain("me");
    expect(ids).not.toContain("tab");
  });

  it("keeps offline devices, after the online ones", () => {
    const ids = deviceStrip(devices).map((c) => c.device.id);
    expect(ids).toContain("off-1");
    expect(ids.indexOf("off-1")).toBe(ids.length - 1);
  });

  it("puts the open chat's device first", () => {
    expect(deviceStrip(devices, { chatDevice: "ph-1" })[0].device.id).toBe("ph-1");
  });

  it("sizes only the open chat's device up", () => {
    const chips = deviceStrip(devices, { chatDevice: "mac-1" });
    expect(chips.filter((c) => c.focused).map((c) => c.device.id)).toEqual(["mac-1"]);
  });

  it("enlarges nothing when the chat goes nowhere in particular", () => {
    expect(deviceStrip(devices).some((c) => c.focused)).toBe(false);
  });

  it("gives a device its chat back, so a tap returns to it", () => {
    const chips = deviceStrip(devices, { threads: [{ id: "t_1", device: "srv-1" }] });
    expect(chips.find((c) => c.device.id === "srv-1")?.thread).toBe("t_1");
    expect(chips.find((c) => c.device.id === "mac-1")?.thread).toBeNull();
  });

  it("orders the online ones by name under the focused one", () => {
    const names = deviceStrip(devices, { chatDevice: "ph-1" })
      .filter((c) => c.device.online && !c.focused)
      .map((c) => c.device.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("skips a device with no name to draw", () => {
    const withBlank: HubDevice[] = [...devices, { id: "x", name: "   ", kind: "computer", online: true }];
    expect(deviceStrip(withBlank).map((c) => c.device.id)).not.toContain("x");
  });
});
