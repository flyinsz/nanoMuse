import { afterEach, describe, expect, it } from "vitest";
import { setLocaleSetting, t } from "./i18n";
import zhCN from "./i18n/zh-CN";
import { isSelfWord, mentionChoices, mentionPrefix, mentionSuggestions, mentionTarget, SELF_WORDS } from "./mention";
import type { HubDevice } from "./types";

const devices: HubDevice[] = [
  { id: "me", name: "Desk", kind: "computer", online: true, this: true },
  { id: "tab", name: "Chrome", kind: "web", online: true },
  { id: "phone-1", name: "Pixel 8", kind: "phone", online: true },
  { id: "mac-1", name: "Mac mini", kind: "computer", online: false },
  { id: "mac-2", name: "MacBook", kind: "computer", online: true },
];

describe("mention", () => {
  it("knows when a mention is being typed", () => {
    expect(mentionPrefix("@")).toBe("");
    expect(mentionPrefix("@Pi")).toBe("Pi");
    expect(mentionPrefix("@Pixel 8 open")).toBeNull();
    expect(mentionPrefix("hello @Pi")).toBeNull();
  });

  it("offers the other devices whose names start with what was typed, online first", () => {
    expect(mentionSuggestions("@", devices).map((d) => d.id)).toEqual(["mac-2", "phone-1", "mac-1"]);
    expect(mentionSuggestions("@mac", devices).map((d) => d.id)).toEqual(["mac-2", "mac-1"]);
    expect(mentionSuggestions("@pix", devices).map((d) => d.id)).toEqual(["phone-1"]);
    expect(mentionSuggestions("@desk", devices)).toEqual([]);
    expect(mentionSuggestions("plain text", devices)).toEqual([]);
  });

  it("names the device a finished mention goes to, like the runtime does", () => {
    expect(mentionTarget("@Pixel 8 open the calendar", devices)?.id).toBe("phone-1");
    expect(mentionTarget("  @mac mini, list ~/Downloads", devices)?.id).toBe("mac-1");
    expect(mentionTarget("@pix what's on screen", devices)?.id).toBe("phone-1");
    // "mac" starts two names: the one online is meant
    expect(mentionTarget("@mac hello", devices)?.id).toBe("mac-2");
    expect(mentionTarget("@Desk hi", devices)).toBeNull();
    expect(mentionTarget("@Chrome hi", devices)).toBeNull();
    expect(mentionTarget("@nobody hi", devices)).toBeNull();
    expect(mentionTarget("hello @Pixel 8", devices)).toBeNull();
  });
});

afterEach(() => setLocaleSetting("en"));

describe("SELF_WORDS", () => {
  it("is the same two words the runtime and the phone parse", () => {
    // nanomuse/sync/mention.py's SELF_WORDS and DeviceOwner.SELF_WORDS: one table, three
    // ends. A third word here would promise something the send could not do.
    expect(SELF_WORDS).toEqual(["本机", "this device"]);
    expect(SELF_WORDS).toContain("本机");
    expect(SELF_WORDS).toContain("this device");
    expect(SELF_WORDS).not.toContain("This machine");
  });

  it("matches without case, the way the runtime does", () => {
    expect(isSelfWord("本机")).toBe(true);
    expect(isSelfWord("@本机")).toBe(true);
    expect(isSelfWord("this device")).toBe(true);
    expect(isSelfWord("This Device")).toBe(true);
    expect(isSelfWord("@THIS DEVICE ")).toBe(true);
    expect(isSelfWord("This machine")).toBe(false);
    expect(isSelfWord("this devices")).toBe(false);
  });
});

describe("the this-device row the composer offers", () => {
  it("is offered for a word the runtime accepts as this device", () => {
    for (const label of ["本机", "this device", "This device", "@本机", "@This device"]) {
      const [row] = mentionChoices("@", devices, label);
      expect(row?.self, label).toBe(true);
      expect(isSelfWord(row!.name), label).toBe(true);
    }
  });

  it("is not offered for a word the runtime would ignore", () => {
    // The bug this replaces: `@This machine` was offered in English, then read as a device
    // name by the send, so the owner never came back.
    const rows = mentionChoices("@", devices, "This machine");
    expect(rows.some((r) => r.self)).toBe(false);
    expect(rows.map((r) => r.name)).not.toContain("This machine");
  });
});

describe("the @本机 placeholder key", () => {
  it("is @本机 in 简体中文 and a word the runtime reads in English", () => {
    setLocaleSetting("zh-CN");
    expect(t("@This device")).toBe("@本机");
    setLocaleSetting("en");
    // English is the key itself; the send strips the `@` and the runtime matches without case.
    const inserted = t("@This device").replace(/^@/, "");
    expect(isSelfWord(inserted)).toBe(true);
    expect(inserted.toLowerCase()).toBe("this device");
  });

  it("is the only key the composer asks for, so no orphan translation is left behind", () => {
    expect(zhCN["@This device"]).toBe("@本机");
    expect(zhCN["@This machine"]).toBeUndefined();
  });
});
