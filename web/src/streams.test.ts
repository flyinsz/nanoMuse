import { describe, expect, it } from "vitest";
import { appendReasoning, appendText, bucketKey, dropEndedStreams, dropStreamById, endStream, startStream, streamsForThread } from "./streams";

// One conversation, several runs (contract C13): a stream is bucketed by conversation and
// round, so two streams in the same chat never overwrite each other — and a frame from a
// runtime without a round still behaves exactly as before.

describe("bucketing by round", () => {
  it("keeps two streams of one conversation apart, each with its own text", () => {
    let b = startStream({}, "main", "a1", "r1");
    b = startStream(b, "main", "a2", "r2");
    b = appendText(b, "main", "a1", "here ", "r1");
    b = appendText(b, "main", "a2", "there ", "r2");
    b = appendText(b, "main", "a1", "and on", "r1");
    b = appendText(b, "main", "a2", "and on", "r2");
    const list = streamsForThread(b, "main");
    expect(list.map((s) => [s.id, s.text])).toEqual([
      ["a1", "here and on"],
      ["a2", "there and on"],
    ]);
  });

  it("routes a delta to the right round even when a later one opened last", () => {
    let b = startStream({}, "main", "a1", "r1");
    b = startStream(b, "main", "a2", "r2");
    // a straggler from r1 must not land on r2's bucket
    b = appendReasoning(b, "main", "a1", "thinking…", "r1");
    expect(streamsForThread(b, "main").map((s) => [s.id, s.reasoning])).toEqual([
      ["a1", "thinking…"],
      ["a2", ""],
    ]);
  });

  it("ends one round without touching the other", () => {
    let b = startStream({}, "main", "a1", "r1");
    b = startStream(b, "main", "a2", "r2");
    b = appendText(b, "main", "a1", "done", "r1");
    b = appendText(b, "main", "a2", "still going", "r2");
    b = endStream(b, "main", "a1", false, "r1");
    const list = streamsForThread(b, "main");
    expect(list.find((s) => s.id === "a1")?.ended).toBe(true);
    expect(list.find((s) => s.id === "a2")?.ended).toBe(false);
  });

  it("drops only the bucket of the reply that landed", () => {
    let b = startStream({}, "main", "a1", "r1");
    b = startStream(b, "main", "a2", "r2");
    b = appendText(b, "main", "a1", "one", "r1");
    b = appendText(b, "main", "a2", "two", "r2");
    b = dropStreamById(b, "main", "a1");
    expect(streamsForThread(b, "main").map((s) => s.id)).toEqual(["a2"]);
  });

  it("drops only the ended streams when the conversation goes idle", () => {
    let b = startStream({}, "main", "a1", "r1");
    b = startStream(b, "main", "a2", "r2");
    b = appendText(b, "main", "a1", "one", "r1");
    b = appendText(b, "main", "a2", "two", "r2");
    b = endStream(b, "main", "a1", false, "r1");
    b = dropEndedStreams(b, "main");
    expect(streamsForThread(b, "main").map((s) => s.id)).toEqual(["a2"]);
  });

  it("leaves another conversation's streams alone", () => {
    let b = appendText({}, "side", "a9", "hello", "r9");
    const before = b;
    b = dropStreamById(b, "main", "a9");
    b = dropEndedStreams(b, "main");
    expect(b).toBe(before);
    expect(streamsForThread(b, "side").map((s) => s.text)).toEqual(["hello"]);
  });
});

describe("a frame without a round (older runtime)", () => {
  it("keeps the old one-bucket-per-conversation behaviour", () => {
    let b = startStream({}, "main", "a1");
    b = appendText(b, "main", "a1", "hel");
    b = appendText(b, "main", "a1", "lo");
    // a different id with no round replaces the bucket, exactly as before
    b = appendText(b, "main", "a2", "other");
    expect(bucketKey("main")).toBe("main");
    expect(streamsForThread(b, "main").map((s) => [s.id, s.text])).toEqual([["a2", "other"]]);
  });

  it("ends an empty stream right away and keeps a written one until the reply lands", () => {
    let b = startStream({}, "main", "a1");
    b = endStream(b, "main", "a1");
    expect(streamsForThread(b, "main")).toEqual([]);

    let c = appendText({}, "main", "a2", "an answer");
    c = endStream(c, "main", "a2");
    expect(streamsForThread(c, "main").map((s) => [s.id, s.ended])).toEqual([["a2", true]]);
  });

  it("ignores a stream_end for a stream that is not open", () => {
    const b = { main: { id: "a1", text: "x", reasoning: "", ended: false } };
    expect(endStream(b, "main", "a2")).toBe(b);
    expect(endStream(b, "main", "a1", false)).not.toBe(b);
  });
});
