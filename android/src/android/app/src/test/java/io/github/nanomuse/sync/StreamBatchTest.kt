package io.github.nanomuse.sync

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A `stream` frame's shape and the fold of its batches into rounds (executor handoff v2, §C/§4.4). */
class StreamBatchTest {
    private fun frame(
        cid: String = "c1",
        round: String = "r1",
        from: String = "nas-1",
        seq: Int = 1,
        delta: String? = null,
        reasoning: String? = null,
        tool: JSONObject? = null,
        done: Boolean = false,
    ): JSONObject = JSONObject().apply {
        put("type", "stream").put("cid", cid).put("round", round).put("from", from)
        put("seq", seq).put("done", done)
        delta?.let { put("delta", it) }
        reasoning?.let { put("reasoning", it) }
        tool?.let { put("tool", it) }
    }

    private fun tool(name: String = "shell", stage: String = "call", summary: String = "ls", ok: Boolean? = null): JSONObject =
        JSONObject().apply {
            put("name", name).put("stage", stage).put("summary", summary)
            if (ok != null) put("ok", ok)
        }

    // ── reading a frame ────────────────────────────────────────────────────

    @Test fun `a batch of words reads`() {
        val b = StreamBatch.read(frame(delta = "Hel"))!!
        assertEquals("c1", b.cid)
        assertEquals("r1", b.round)
        assertEquals("nas-1", b.from)
        assertEquals(1, b.seq)
        assertEquals("Hel", b.delta)
        assertNull(b.reasoning)
        assertNull(b.tool)
        assertFalse(b.done)
    }

    @Test fun `a frame that names no conversation or round is left alone`() {
        assertNull(StreamBatch.read(frame(cid = "")))
        assertNull(StreamBatch.read(frame(round = "  ")))
        assertNull(StreamBatch.read(null))
        // not a stream frame at all
        assertNull(StreamBatch.read(JSONObject("""{"type":"working","cid":"c1","round":"r1"}""")))
    }

    @Test fun `a frame with nothing to draw is left alone, but a bare done is kept`() {
        assertNull(StreamBatch.read(frame()))
        assertNull(StreamBatch.read(frame(delta = "", reasoning = "")))
        assertEquals(true, StreamBatch.read(frame(done = true))!!.done)
    }

    @Test fun `a batch carries the device's display name`() {
        val b = StreamBatch.read(frame(delta = "x").put("device_name", "飞牛深圳"))!!
        assertEquals("飞牛深圳", b.deviceName)
    }

    @Test fun `a missing or non-positive seq reads as zero`() {
        assertEquals(0, StreamBatch.read(frame(delta = "x").apply { remove("seq") })!!.seq)
        assertEquals(0, StreamBatch.read(frame(seq = -3, delta = "x"))!!.seq)
        assertEquals(4, StreamBatch.read(frame(seq = 4, delta = "x"))!!.seq)
    }

    @Test fun `a tool step reads with its stage, summary and outcome`() {
        val call = StreamBatch.read(frame(delta = "", tool = tool()))!!.tool!!
        assertEquals("shell", call.name)
        assertEquals(StreamBatch.CALL, call.stage)
        assertEquals("ls", call.summary)
        assertTrue(call.ok) // no `ok` field reads as a success

        val result = StreamBatch.read(frame(delta = "", tool = tool(stage = "result", ok = false)))!!.tool!!
        assertEquals(StreamBatch.RESULT, result.stage)
        assertTrue(result.name.isNotEmpty())
        assertFalse(result.ok)

        // a stage this build does not know reads as a call rather than as nothing
        assertEquals(StreamBatch.CALL, StreamBatch.read(frame(delta = "", tool = tool(stage = "weird")))!!.tool!!.stage)
    }

    @Test fun `a tool with neither name nor stage is not a step`() {
        assertNull(StreamBatch.read(frame(delta = "", tool = JSONObject("""{"summary":"x"}"""))))
    }

    @Test fun `a bare tool frame is worth drawing, a tool-less empty one is not`() {
        val b = StreamBatch.read(frame(tool = tool()))!!
        assertEquals("shell", b.tool!!.name)
        assertNull(b.delta)
    }

    // ── folding batches into rounds ────────────────────────────────────────

    private fun batch(round: String = "r1", seq: Int = 1, delta: String? = null, reasoning: String? = null, done: Boolean = false, cid: String = "c1") =
        StreamBatch(cid, round, "nas-1", "飞牛深圳", seq, delta, reasoning, null, done)

    @Test fun `batches append in order, and the round keeps the device it opened with`() {
        var rounds = emptyMap<String, Streams.Bucket>()
        rounds = Streams.merge(rounds, batch(seq = 1, delta = "Hel"), 100)
        rounds = Streams.merge(rounds, batch(seq = 2, delta = "lo"), 200)
        val b = rounds.getValue("r1")
        assertEquals("Hello", b.text)
        assertEquals("nas-1", b.from)
        assertEquals(2, b.seq)
        assertEquals(200, b.at)
    }

    @Test fun `two rounds of one chat are kept apart`() {
        var rounds = emptyMap<String, Streams.Bucket>()
        rounds = Streams.merge(rounds, batch(round = "r1", seq = 1, delta = "one"), 100)
        rounds = Streams.merge(rounds, batch(round = "r2", seq = 1, delta = "two"), 200)
        assertEquals("one", rounds.getValue("r1").text)
        assertEquals("two", rounds.getValue("r2").text)
    }

    @Test fun `a duplicate batch is dropped, not appended twice`() {
        var rounds = emptyMap<String, Streams.Bucket>()
        rounds = Streams.merge(rounds, batch(seq = 3, delta = "abc"), 100)
        val same = Streams.merge(rounds, batch(seq = 3, delta = "abc"), 200)
        assertEquals(rounds, same)
        val older = Streams.merge(rounds, batch(seq = 2, delta = "xy"), 300)
        assertEquals(rounds, older)
        assertEquals("abc", rounds.getValue("r1").text)
    }

    @Test fun `a seq of zero never blocks a batch`() {
        // a sender that gave no seq must still be drawn: only a positive seq is compared
        var rounds = emptyMap<String, Streams.Bucket>()
        rounds = Streams.merge(rounds, batch(seq = 1, delta = "a"), 100)
        rounds = Streams.merge(rounds, batch(seq = 0, delta = "b"), 200)
        assertEquals("ab", rounds.getValue("r1").text)
    }

    @Test fun `nothing arrives after the round is done`() {
        var rounds = emptyMap<String, Streams.Bucket>()
        rounds = Streams.merge(rounds, batch(delta = "last", done = true), 100)
        val after = Streams.merge(rounds, batch(seq = 9, delta = "late"), 200)
        assertEquals(rounds, after)
        assertEquals("last", rounds.getValue("r1").text)
        assertTrue(rounds.getValue("r1").done)
    }

    @Test fun `a done with the last words keeps them`() {
        // the closing batch and `done` in one frame: neither may be lost to the order
        var rounds = emptyMap<String, Streams.Bucket>()
        rounds = Streams.merge(rounds, batch(delta = "the end", done = true), 100)
        assertEquals("the end", rounds.getValue("r1").text)
        assertTrue(rounds.getValue("r1").done)
    }

    @Test fun `a done whose opening batch was lost still reaches the bubble`() {
        // nothing has been drawn for this round; a bare close must not be dropped
        val rounds = Streams.merge(emptyMap(), batch(round = "r9", done = true), 100)
        assertTrue(rounds.containsKey("r9"))
        assertTrue(rounds.getValue("r9").done)
        assertFalse(rounds.getValue("r9").drawable)
    }

    @Test fun `reasoning and steps ride along with the words`() {
        var rounds = emptyMap<String, Streams.Bucket>()
        rounds = Streams.merge(rounds, batch(seq = 1, delta = "a", reasoning = "think"), 100)
        rounds = Streams.merge(rounds, batch(seq = 2, delta = "b", reasoning = "ing"), 200)
        val b = rounds.getValue("r1")
        assertEquals("ab", b.text)
        assertEquals("thinking", b.reasoning)
    }

    @Test fun `a batch with no reasoning does not clear what was drawn`() {
        var rounds = emptyMap<String, Streams.Bucket>()
        rounds = Streams.merge(rounds, batch(seq = 1, reasoning = "why"), 100)
        rounds = Streams.merge(rounds, batch(seq = 2, delta = "x"), 200)
        assertEquals("why", rounds.getValue("r1").reasoning)
    }

    @Test fun `steps are kept in the order they arrived`() {
        val step = StreamBatch.Tool("shell", StreamBatch.CALL, "ls", true)
        var rounds = emptyMap<String, Streams.Bucket>()
        rounds = Streams.merge(rounds, batch(seq = 1, delta = "a").copy(tool = step), 100)
        rounds = Streams.merge(rounds, batch(seq = 2).copy(tool = step.copy(stage = StreamBatch.RESULT)), 200)
        assertEquals(listOf(StreamBatch.CALL, StreamBatch.RESULT), rounds.getValue("r1").tools.map { it.stage })
    }

    // ── what is drawn, and for how long ────────────────────────────────────

    @Test fun `a round this phone ran is not drawn, nor is one with nothing in it`() {
        var rounds = emptyMap<String, Streams.Bucket>()
        rounds = Streams.merge(rounds, batch(seq = 1, delta = "mine").copy(from = "phone-main"), 100)
        rounds = Streams.merge(rounds, batch(round = "r2", seq = 1, done = true).copy(from = "nas-1"), 100)
        assertTrue(Streams.live(rounds, "phone-main", 150).isEmpty())
    }

    @Test fun `a running round is drawn, and a finished one only for its grace`() {
        var rounds = emptyMap<String, Streams.Bucket>()
        rounds = Streams.merge(rounds, batch(round = "run", seq = 1, delta = "working"), 1_000)
        rounds = Streams.merge(rounds, batch(round = "fin", seq = 1, delta = "done", done = true), 1_000)
        assertEquals(setOf("run", "fin"), Streams.live(rounds, "me", 1_000).map { it.round }.toSet())
        // the finished round's grace runs out first
        assertEquals(setOf("run"), Streams.live(rounds, "me", 1_000 + Streams.GRACE_MS + 1).map { it.round }.toSet())
        // and a quiet, unterminated one is bounded too
        assertTrue(Streams.live(rounds, "me", 1_000 + Streams.QUIET_MS + 1).isEmpty())
    }

    @Test fun `a quiet round never spins forever`() {
        val rounds = Streams.merge(emptyMap(), batch(delta = "half"), 1_000)
        assertEquals(1, rounds.size) // still inside the quiet window
        assertTrue(Streams.prune(rounds, 1_000 + Streams.QUIET_MS + 1).isEmpty())
    }

    @Test fun `the newest round is drawn first`() {
        var rounds = emptyMap<String, Streams.Bucket>()
        rounds = Streams.merge(rounds, batch(round = "old", seq = 1, delta = "a"), 100)
        rounds = Streams.merge(rounds, batch(round = "new", seq = 1, delta = "b"), 200)
        assertEquals(listOf("new", "old"), Streams.live(rounds, "me", 200).map { it.round })
    }

    @Test fun `prune keeps the live rounds and drops the rest`() {
        val now = 1_000_000L
        var rounds = emptyMap<String, Streams.Bucket>()
        rounds = Streams.merge(rounds, batch(round = "live", seq = 1, delta = "a"), now)
        rounds = Streams.merge(rounds, batch(round = "stale", seq = 1, delta = "b"), 0)
        assertEquals(setOf("live", "stale"), rounds.keys)
        assertEquals(setOf("live"), Streams.prune(rounds, now).keys)
    }

    @Test fun `a row that appeared while the turn ran says it finished`() {
        // nanoMuse: what decides whether a failed call for a handed-over turn is worth a
        // "did not answer" line. The hub socket drops and reconnects on its own, and a call
        // running across a drop never hears its result, while the far device finishes and
        // pushes as usual — measured, the chat then read "NAS-by-Donny 未回复" underneath the
        // answer that had arrived.
        assertTrue(RowBaseline.arrived(setOf("old"), setOf("old", "new")))
        assertTrue(RowBaseline.arrived(emptySet(), setOf("new")))
    }

    @Test fun `an answer from an earlier turn is not this turn's`() {
        // the chat already holds what another device wrote before; that must not read as the
        // handed-over turn having finished
        assertFalse(RowBaseline.arrived(setOf("old"), setOf("old")))
        assertFalse(RowBaseline.arrived(setOf("a", "b"), setOf("a", "b")))
        assertFalse(RowBaseline.arrived(emptySet(), emptySet()))
    }
}
