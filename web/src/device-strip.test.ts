import { describe, expect, it } from "vitest";
import { faceRow, muses } from "./device-strip";
import type { HubDevice } from "./types";

/**
 * The account's Muses as the header's row of faces: which are drawn, in what order, and which
 * one is in the middle. The rules both clients share.
 *
 * Every device wears the same face (the profile is one per account), so the row is not about
 * telling faces apart: it is about who is there, and whose chat is open.
 */
const devices: HubDevice[] = [
  { id: "me", name: "Desk", kind: "computer", online: true, this: true },
  { id: "tab", name: "Chrome", kind: "web", online: true },
  { id: "mac-1", name: "Mac mini", kind: "computer", online: true },
  { id: "srv-1", name: "服务器", kind: "computer", online: true },
  { id: "ph-1", name: "Pixel 8", kind: "phone", online: true },
  { id: "off-1", name: "Old Laptop", kind: "computer", online: false },
];

describe("muses", () => {
  it("keeps this device and leaves out other tabs", () => {
    const ids = muses(devices).map((f) => f.device.id);
    expect(ids).toContain("me");
    expect(ids).not.toContain("tab");
  });

  it("puts this device first among the ones that are not open", () => {
    expect(muses(devices)[0].device.id).toBe("me");
  });

  it("keeps offline devices, after the online ones", () => {
    const ids = muses(devices).map((f) => f.device.id);
    expect(ids).toContain("off-1");
    expect(ids.indexOf("off-1")).toBe(ids.length - 1);
  });

  it("puts the open chat's device first", () => {
    expect(muses(devices, { chatDevice: "ph-1" })[0].device.id).toBe("ph-1");
  });

  it("gives a device its chat back, so a tap returns to it", () => {
    const all = muses(devices, { threads: [{ id: "t_1", device: "srv-1" }] });
    expect(all.find((f) => f.device.id === "srv-1")?.thread).toBe("t_1");
    expect(all.find((f) => f.device.id === "mac-1")?.thread).toBeNull();
  });

  it("skips a device with no name to draw", () => {
    const blank: HubDevice[] = [...devices, { id: "x", name: "   ", kind: "computer", online: true }];
    expect(muses(blank).map((f) => f.device.id)).not.toContain("x");
  });
});

describe("faceRow", () => {
  it("puts the open chat's device in the middle", () => {
    expect(faceRow(devices, { chatDevice: "srv-1" }).middle?.device.id).toBe("srv-1");
  });

  it("draws this device in the middle when the chat goes nowhere in particular", () => {
    expect(faceRow(devices).middle?.device.id).toBe("me");
  });

  it("does not draw the middle face on either side", () => {
    const row = faceRow(devices, { chatDevice: "srv-1" });
    expect([...row.left, ...row.right].map((f) => f.device.id)).not.toContain("srv-1");
  });

  it("draws every Muse exactly once", () => {
    const row = faceRow(devices, { chatDevice: "srv-1" });
    const drawn = [...row.left, ...row.right, ...(row.middle ? [row.middle] : [])].map((f) => f.device.id);
    expect(drawn.length).toBe(new Set(drawn).size);
    expect(drawn.length).toBe(muses(devices).length);
  });

  it("keeps the two sides within one of each other", () => {
    const row = faceRow(devices, { chatDevice: "srv-1" });
    expect(Math.abs(row.left.length - row.right.length)).toBeLessThanOrEqual(1);
  });

  it("falls back to this device when the chat's device is gone", () => {
    expect(faceRow(devices, { chatDevice: "gone-1" }).middle?.device.id).toBe("me");
  });

  it("splits into two empty sides when there is no device", () => {
    const row = faceRow([]);
    expect(row.middle).toBeNull();
    expect(row.left.length + row.right.length).toBe(0);
  });
});
