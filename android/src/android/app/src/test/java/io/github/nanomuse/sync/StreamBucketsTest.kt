package io.github.nanomuse.sync

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A turn running on another device, as the relay's `stream` frames describe it (contract C13, §4):
 * which turn a batch belongs to, what it does to the bubble, and when the bubble goes.
 *
 * The merge is a pure function, so these check the rule every caller shares without a renderer:
 * two turns in one chat stay apart, a step keeps its place among the words, a duplicate or a late
 * frame changes nothing, and a frame that is not a stream is ignored rather than half-drawn.
 */
class StreamBucketsTest {

    private fun frame(
        json: String,
    ): StreamBuckets.StreamFrame = StreamBuckets.read(JSONObject(json))!!

    private fun batch(
        seq: Int = 1,
        delta: String? = null,
        reasoning: String? = null,
        tool: String? = null,
        done: Boolean = false,
        round: String = "r1",
        cid: String = "c1",
    ): String {
        val parts = mutableListOf("\"type\":\"stream\"", "\"cid\":\"$cid\"", "\"round\":\"$round\"", "\"from\":\"other\"", "\"seq\":$seq")
        delta?.let { parts += "\"delta\":${JSONObject.quote(it)}" }
        reasoning?.let { parts += "\"reasoning\":${JSONObject.quote(it)}" }
        tool?.let { parts += "\"tool\":$it" }
        if (done) parts += "\"done\":true"
        return "{${parts.joinToString(",")}}"
    }

    @Test
    fun `a batch is read off the wire`() {
        val f = frame(batch(seq = 3, delta = "hello", tool = "{\"name\":\"shell\",\"stage\":\"call\"}"))
        assertEquals("c1", f.cid)
        assertEquals("r1", f.round)
        assertEquals("other", f.from)
        assertEquals(3, f.seq)
        assertEquals("hello", f.delta)
        assertEquals("shell", f.tool?.name)
        assertEquals("call", f.tool?.stage)
        assertEquals(false, f.done)
    }

    @Test
    fun `a frame that is not a stream is left alone`() {
        assertNull(StreamBuckets.read(JSONObject("{\"type\":\"working\",\"cid\":\"c1\"}")))
        assertNull(StreamBuckets.read(null))
    }

    @Test
    fun `a frame with no conversation or no round is left alone`() {
        assertNull(StreamBuckets.read(JSONObject(batch(cid = ""))))
        assertNull(StreamBuckets.read(JSONObject(batch(round = ""))))
    }

    @Test
    fun `a frame with nothing to draw is left alone, but a lone done closes a round`() {
        assertNull(StreamBuckets.read(JSONObject(batch())))
        assertEquals(true, StreamBuckets.read(JSONObject(batch(done = true)))?.done)
    }

    @Test
    fun `batches grow one bubble per round`() {
        var buckets = emptyMap<String, StreamBuckets.StreamBucket>()
        buckets = StreamBuckets.apply(buckets, frame(batch(seq = 1, delta = "Hel")), 100)
        buckets = StreamBuckets.apply(buckets, frame(batch(seq = 2, delta = "lo")), 200)
        val bucket = buckets.getValue(StreamBuckets.key("c1", "r1"))
        assertEquals("Hello", bucket.text)
        assertEquals(2, bucket.seq)
    }

    @Test
    fun `two turns in one chat stay apart`() {
        // the whole point of the round: the second turn's first token must not wipe the first's
        var buckets = emptyMap<String, StreamBuckets.StreamBucket>()
        buckets = StreamBuckets.apply(buckets, frame(batch(seq = 1, delta = "one", round = "r1")), 100)
        buckets = StreamBuckets.apply(buckets, frame(batch(seq = 1, delta = "two", round = "r2")), 200)
        assertEquals("one", buckets.getValue(StreamBuckets.key("c1", "r1")).text)
        assertEquals("two", buckets.getValue(StreamBuckets.key("c1", "r2")).text)
    }

    @Test
    fun `the same round in two chats does not collide`() {
        var buckets = emptyMap<String, StreamBuckets.StreamBucket>()
        buckets = StreamBuckets.apply(buckets, frame(batch(seq = 1, delta = "a", cid = "c1", round = "r1")), 100)
        buckets = StreamBuckets.apply(buckets, frame(batch(seq = 1, delta = "b", cid = "c2", round = "r1")), 200)
        assertEquals("a", buckets.getValue(StreamBuckets.key("c1", "r1")).text)
        assertEquals("b", buckets.getValue(StreamBuckets.key("c2", "r1")).text)
    }

    @Test
    fun `a duplicate or a late frame changes nothing`() {
        val first = StreamBuckets.apply(emptyMap(), frame(batch(seq = 5, delta = "x")), 100)
        assertSame(first, StreamBuckets.apply(first, frame(batch(seq = 5, delta = "x")), 200))
        assertSame(first, StreamBuckets.apply(first, frame(batch(seq = 4, delta = "y")), 300))
    }

    @Test
    fun `a frame after done is dropped`() {
        var buckets = StreamBuckets.apply(emptyMap(), frame(batch(seq = 1, delta = "x", done = true)), 100)
        buckets = StreamBuckets.apply(buckets, frame(batch(seq = 2, delta = "y")), 200)
        assertEquals("x", buckets.getValue(StreamBuckets.key("c1", "r1")).text)
    }

    @Test
    fun `a step is a row, kept in order`() {
        var buckets = StreamBuckets.apply(emptyMap(), frame(batch(tool = "{\"name\":\"read_file\",\"stage\":\"call\"}")), 100)
        buckets = StreamBuckets.apply(
            buckets,
            frame(batch(seq = 2, tool = "{\"name\":\"read_file\",\"stage\":\"result\",\"summary\":\"12 lines\"}")),
            200,
        )
        val tools = buckets.getValue(StreamBuckets.key("c1", "r1")).tools
        assertEquals(listOf("call", "result"), tools.map { it.stage })
        assertEquals("read_file \u00b7 12 lines", tools[1].line)
    }

    @Test
    fun `a failed step carries that`() {
        val buckets = StreamBuckets.apply(
            emptyMap(),
            frame(batch(tool = "{\"name\":\"rm\",\"stage\":\"result\",\"ok\":false,\"summary\":\"denied\"}")),
            100,
        )
        assertEquals(false, buckets.getValue(StreamBuckets.key("c1", "r1")).tools[0].ok)
    }

    @Test
    fun `a step remembers where the words stood when it happened`() {
        // one turn: prose, a step, the prose after it. The bubble has to keep that order.
        var buckets = StreamBuckets.apply(emptyMap(), frame(batch(delta = "let me look")), 100)
        buckets = StreamBuckets.apply(buckets, frame(batch(seq = 2, tool = "{\"name\":\"shell\",\"stage\":\"call\"}")), 200)
        buckets = StreamBuckets.apply(buckets, frame(batch(seq = 3, delta = " here you are")), 300)
        val bucket = buckets.getValue(StreamBuckets.key("c1", "r1"))
        assertEquals("let me look".length, bucket.tools[0].textAt)
        assertEquals("let me look here you are", bucket.text)
    }

    @Test
    fun `a turn reads in the order it happened`() {
        var buckets = StreamBuckets.apply(emptyMap(), frame(batch(delta = "let me look")), 100)
        buckets = StreamBuckets.apply(buckets, frame(batch(seq = 2, tool = "{\"name\":\"shell\",\"stage\":\"call\"}")), 200)
        buckets = StreamBuckets.apply(buckets, frame(batch(seq = 3, delta = " here you are")), 300)
        val blocks = StreamBuckets.blocks(buckets.getValue(StreamBuckets.key("c1", "r1")))
        assertEquals(3, blocks.size)
        assertEquals("let me look", (blocks[0] as StreamBuckets.Block.Text).markdown)
        assertTrue(blocks[1] is StreamBuckets.Block.Step)
        assertEquals(" here you are", (blocks[2] as StreamBuckets.Block.Text).markdown)
    }

    @Test
    fun `text without a step draws as one run`() {
        val buckets = StreamBuckets.apply(emptyMap(), frame(batch(delta = "just words")), 100)
        val blocks = StreamBuckets.blocks(buckets.getValue(StreamBuckets.key("c1", "r1")))
        assertEquals(1, blocks.size)
        assertEquals("just words", (blocks[0] as StreamBuckets.Block.Text).markdown)
    }

    @Test
    fun `a round from this phone is not drawn`() {
        val buckets = StreamBuckets.apply(emptyMap(), frame(batch(delta = "x")), 100)
        assertEquals(0, StreamBuckets.live(buckets, "c1", selfId = "other", now = 150).size)
        assertEquals(1, StreamBuckets.live(buckets, "c1", selfId = "me", now = 150).size)
    }

    @Test
    fun `a finished round is kept only while its text lands`() {
        val buckets = StreamBuckets.apply(emptyMap(), frame(batch(delta = "x", done = true)), 100)
        assertEquals(1, StreamBuckets.live(buckets, "c1", selfId = "me", now = 100 + StreamBuckets.STREAM_GRACE_MS - 1).size)
        assertEquals(0, StreamBuckets.live(buckets, "c1", selfId = "me", now = 100 + StreamBuckets.STREAM_GRACE_MS + 1).size)
    }

    @Test
    fun `a round that went quiet ages out`() {
        val buckets = StreamBuckets.apply(emptyMap(), frame(batch(delta = "x")), 100)
        assertEquals(1, StreamBuckets.live(buckets, "c1", selfId = "me", now = 100 + StreamBuckets.STREAM_QUIET_MS - 1).size)
        assertEquals(0, StreamBuckets.live(buckets, "c1", selfId = "me", now = 100 + StreamBuckets.STREAM_QUIET_MS + 1).size)
    }

    @Test
    fun `a round with nothing in it is not drawn`() {
        val buckets = StreamBuckets.apply(emptyMap(), frame(batch(done = true)), 100)
        assertEquals(0, StreamBuckets.live(buckets, "c1", selfId = "me", now = 150).size)
    }

    @Test
    fun `pruning drops what live would not draw`() {
        var buckets = StreamBuckets.apply(emptyMap(), frame(batch(delta = "x", done = true)), 100)
        buckets = StreamBuckets.apply(buckets, frame(batch(seq = 1, delta = "y", round = "r2")), 200)
        val pruned = StreamBuckets.prune(buckets, now = 100 + StreamBuckets.STREAM_GRACE_MS + 1)
        assertEquals(listOf("r2"), pruned.values.map { it.round })
    }
}
