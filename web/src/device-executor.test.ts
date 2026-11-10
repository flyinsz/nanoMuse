import { describe, expect, it } from "vitest";
import { executorOf } from "./device-executor";
import type { HubDevice, ThreadMeta } from "./types";

const devices: HubDevice[] = [
  { id: "me", name: "Desk", kind: "computer", online: true, this: true },
  { id: "fn", name: "飞牛深圳", kind: "computer", online: true },
];

const thread = (over: Partial<ThreadMeta> = {}): ThreadMeta => ({
  id: "main",
  title: "Main",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  busy: false,
  queued: 0,
  events: 0,
  ...over,
});

describe("executorOf", () => {
  it("is this device for a chat that names no other one", () => {
    expect(executorOf(thread())).toEqual({ here: true, name: "" });
    expect(executorOf(undefined)).toEqual({ here: true, name: "" });
  });

  it("reads the owner the conversation row reports", () => {
    expect(executorOf(thread({ owner_device: "fn", owner_device_name: "飞牛深圳" }), devices)).toEqual({
      here: false,
      name: "飞牛深圳",
    });
  });

  it("prefers the owner over the device the chat was addressed to", () => {
    expect(executorOf(thread({ device: "me", device_name: "Desk", owner_device: "fn", owner_device_name: "飞牛" }), devices)).toEqual({
      here: false,
      name: "飞牛",
    });
  });

  it("falls back to the device a chat was addressed to", () => {
    expect(executorOf(thread({ device: "fn", device_name: "飞牛深圳" }), devices)).toEqual({ here: false, name: "飞牛深圳" });
  });

  it("names an id it does not have a display name for", () => {
    expect(executorOf(thread({ device: "ghost" }), devices)).toEqual({ here: false, name: "ghost" });
  });

  it("looks the id up on the hub when the row carries no name", () => {
    expect(executorOf(thread({ device: "fn" }), devices)).toEqual({ here: false, name: "飞牛深圳" });
  });

  it("takes a blank owner as this device", () => {
    expect(executorOf(thread({ owner_device: "   " }), devices)).toEqual({ here: true, name: "" });
  });
});
