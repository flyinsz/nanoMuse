import { describe, expect, it } from "vitest";
import {
  applyStreamPart,
  deviceNameOf,
  deviceOfId,
  DEVICE_STREAM_TTL_MS,
  dropConversation,
  settleConversation,
  startStreamPart,
  streamForConversation,
  streamKey,
} from "./stream-buckets";
import type { HubDevice } from "./types";

const at = (n: number) => 1_700_000_000_000 + n;

// The runtime's id for a run: `{round}:{device}`.
const id = (round: string, device = "phone-1") => `${round}:${device}`;

describe("deviceOfId", () => {
  it("reads the device half of the runtime's id", () => {
    expect(deviceOfId("r1:phone-1")).toBe("phone-1");
    expect(deviceOfId("round:with:colons:desk")).toBe("desk");
  });

  it("is empty when the id carries no device", () => {
    expect(deviceOfId("r1")).toBe("");
  });
});

describe("deviceNameOf", () => {
  const devices: HubDevice[] = [{ id: "phone-1", name: "Pixel 8", kind: "phone", online: true }];

  it("names a device from the hub's list, and falls back to the id", () => {
    expect(deviceNameOf("phone-1", devices)).toBe("Pixel 8");
    expect(deviceNameOf("ghost", devices)).toBe("ghost");
  });
});

describe("startStreamPart", () => {
  it("opens an empty bucket for a run", () => {
    const b = startStreamPart({}, { id: id("r1"), conv: "main" }, at(0));
    const s = streamForConversation(b, "main", at(0));
    expect(s?.text).toBe("");
    expect(s?.ended).toBe(false);
    expect(s?.device).toBe("phone-1");
  });

  it("leaves a run already open alone", () => {
    let b = startStreamPart({}, { id: id("r1"), conv: "main" }, at(0));
    b = applyStreamPart(b, { id: id("r1"), conv: "main", delta: "hi" }, at(1));
    const again = startStreamPart(b, { id: id("r1"), conv: "main" }, at(2));
    expect(again).toBe(b);
  });

  it("needs an id and a chat", () => {
    expect(startStreamPart({}, { id: "", conv: "main" }, at(0))).toEqual({});
    expect(startStreamPart({}, { id: id("r1"), conv: "" }, at(0))).toEqual({});
  });

  it("takes the relay's display name when it came along", () => {
    const b = startStreamPart({}, { id: id("r1"), conv: "main", deviceName: "飞牛深圳" }, at(0));
    expect(streamForConversation(b, "main", at(0))?.deviceName).toBe("飞牛深圳");
  });
});

describe("applyStreamPart", () => {
  it("adds text and reasoning up batch by batch", () => {
    let b = applyStreamPart({}, { id: id("r1"), conv: "main", delta: "Hel" }, at(0));
    b = applyStreamPart(b, { id: id("r1"), conv: "main", reasoning: "hm" }, at(1));
    b = applyStreamPart(b, { id: id("r1"), conv: "main", delta: "lo", reasoning: "m" }, at(2));
    const s = streamForConversation(b, "main", at(2));
    expect(s?.text).toBe("Hello");
    expect(s?.reasoning).toBe("hmm");
  });

  it("keeps two runs of the same chat apart, by id", () => {
    let b = applyStreamPart({}, { id: id("a", "phone"), conv: "main", delta: "phone says" }, at(0));
    b = applyStreamPart(b, { id: id("b", "desk"), conv: "main", delta: "desk says" }, at(1));
    expect(Object.keys(b).sort()).toEqual([streamKey("main", id("a", "phone")), streamKey("main", id("b", "desk"))].sort());
    // the newest run is the one drawn
    expect(streamForConversation(b, "main", at(1))?.text).toBe("desk says");
  });

  it("counts the step a run reported", () => {
    const b = applyStreamPart({}, { id: id("r1"), conv: "main", tool: { name: "web_fetch", stage: "call" } }, at(0));
    expect(streamForConversation(b, "main", at(0))?.tool).toEqual({ name: "web_fetch", stage: "call" });
  });

  it("does not open a run on an empty batch, or an empty tool", () => {
    expect(applyStreamPart({}, { id: id("r1"), conv: "main" }, at(0))).toEqual({});
    expect(applyStreamPart({}, { id: id("r1"), conv: "main", tool: {} }, at(0))).toEqual({});
  });

  it("needs an id and a chat", () => {
    expect(applyStreamPart({}, { id: "", conv: "main", delta: "x" }, at(0))).toEqual({});
    expect(applyStreamPart({}, { id: id("r1"), conv: "", delta: "x" }, at(0))).toEqual({});
  });

  it("closes the run on done and keeps it until the synced reply replaces it", () => {
    let b = applyStreamPart({}, { id: id("r1"), conv: "main", delta: "hi" }, at(0));
    b = applyStreamPart(b, { id: id("r1"), conv: "main", done: true }, at(1));
    expect(b[streamKey("main", id("r1"))]?.ended).toBe(true);
    // still drawn, just not as still-running, so the bubble does not blink out before sync
    expect(streamForConversation(b, "main", at(1))?.text).toBe("hi");
  });

  it("ignores a done for a run it never drew", () => {
    expect(applyStreamPart({}, { id: id("r1"), conv: "main", done: true }, at(0))).toEqual({});
  });

  it("does not resurrect a run a done already closed", () => {
    let b = applyStreamPart({}, { id: id("r1"), conv: "main", delta: "hi" }, at(0));
    b = applyStreamPart(b, { id: id("r1"), conv: "main", done: true }, at(1));
    const closed = b[streamKey("main", id("r1"))];
    b = applyStreamPart(b, { id: id("r1"), conv: "main", delta: "late" }, at(2));
    expect(b[streamKey("main", id("r1"))]).toBe(closed);
    expect(closed?.ended).toBe(true);
  });

  it("lets go of a run that went quiet past the TTL", () => {
    let b = applyStreamPart({}, { id: id("old"), conv: "main", delta: "gone" }, at(0));
    // a later batch in another chat prunes the stale one
    b = applyStreamPart(b, { id: id("live"), conv: "third", delta: "now" }, at(DEVICE_STREAM_TTL_MS));
    expect(b[streamKey("main", id("old"))]).toBeUndefined();
    expect(streamForConversation(b, "third", at(DEVICE_STREAM_TTL_MS))?.text).toBe("now");
  });

  it("keeps a run that is still fresh", () => {
    const b = applyStreamPart({}, { id: id("r1"), conv: "main", delta: "hi" }, at(0));
    expect(streamForConversation(b, "main", at(DEVICE_STREAM_TTL_MS - 1))?.text).toBe("hi");
    expect(streamForConversation(b, "main", at(DEVICE_STREAM_TTL_MS))).toBeUndefined();
  });

  it("picks the newest run by its last batch, not by insertion order", () => {
    let b = applyStreamPart({}, { id: id("a"), conv: "main", delta: "old" }, at(0));
    b = applyStreamPart(b, { id: id("b"), conv: "main", delta: "new" }, at(5));
    b = applyStreamPart(b, { id: id("a"), conv: "main", delta: "+" }, at(9));
    expect(streamForConversation(b, "main", at(9))?.text).toBe("old+");
  });

  it("draws a live run over a closed one, whatever their times", () => {
    let b = applyStreamPart({}, { id: id("over"), conv: "main", delta: "first" }, at(0));
    b = applyStreamPart(b, { id: id("over"), conv: "main", done: true }, at(1));
    b = applyStreamPart(b, { id: id("live"), conv: "main", delta: "second" }, at(2));
    expect(streamForConversation(b, "main", at(2))?.text).toBe("second");
  });
});

describe("dropConversation", () => {
  it("takes every run of a chat and leaves the others", () => {
    let b = applyStreamPart({}, { id: id("r1"), conv: "main", delta: "a" }, at(0));
    b = applyStreamPart(b, { id: id("r2"), conv: "main", delta: "b" }, at(1));
    b = applyStreamPart(b, { id: id("r1"), conv: "side", delta: "c" }, at(2));
    const gone = dropConversation(b, "main");
    expect(streamForConversation(gone, "main", at(2))).toBeUndefined();
    expect(streamForConversation(gone, "side", at(2))?.text).toBe("c");
  });
});

describe("settleConversation", () => {
  it("lets the ended runs of a chat go when their reply lands, and leaves the live ones", () => {
    let b = applyStreamPart({}, { id: id("over"), conv: "main", delta: "done" }, at(0));
    b = applyStreamPart(b, { id: id("over"), conv: "main", done: true }, at(1));
    b = applyStreamPart(b, { id: id("live"), conv: "main", delta: "now" }, at(2));
    b = applyStreamPart(b, { id: id("there"), conv: "side", delta: "x" }, at(2));
    b = applyStreamPart(b, { id: id("there"), conv: "side", done: true }, at(2));
    const after = settleConversation(b, "main");
    expect(after[streamKey("main", id("over"))]).toBeUndefined();
    expect(after[streamKey("main", id("live"))]?.text).toBe("now");
    // another chat's ended run is not this chat's business
    expect(after[streamKey("side", id("there"))]?.ended).toBe(true);
  });

  it("takes a still-live run too when the reply arrived from another device", () => {
    // the `stream_end` can lose the race with sync: a synced reply means the run is over
    let b = applyStreamPart({}, { id: id("r1"), conv: "main", delta: "half" }, at(0));
    b = settleConversation(b, "main", true);
    expect(b[streamKey("main", id("r1"))]).toBeUndefined();
  });

  it("keeps a live run when the reply was this device's own", () => {
    let b = applyStreamPart({}, { id: id("r1"), conv: "main", delta: "half" }, at(0));
    b = settleConversation(b, "main", false);
    expect(b[streamKey("main", id("r1"))]?.text).toBe("half");
  });
});
