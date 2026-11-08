package io.github.nanomuse.sync

import org.json.JSONObject

/**
 * A turn running on another device of the account, as the relay fans it out (contract C13, §4).
 *
 * The relay sends a `stream` frame every 200 to 250 ms while a turn runs elsewhere: the words it
 * has written so far, its reasoning, and a step each time it calls a tool. `delta` and `reasoning`
 * are batches to append; `tool` is one event of its own, not a batch.
 *
 * ## Rounds are the key, not conversations
 *
 * One conversation can have two turns at once, and the frame's `round` is what tells them apart,
 * so the state here is a map keyed by `cid` and `round` rather than by conversation alone. A key
 * that were only the conversation would let the second turn overwrite the first's bubble.
 *
 * ## Why this is a plain object and a pure function
 *
 * The drawing wants to update one bubble in place rather than re-render the chat, and a plain map
 * is what a list of composables hangs off. Keeping the merge pure means it can be checked with
 * JUnit and no renderer, the way [io.github.nanomuse.terminal.DeviceStrip] is: `applyStreamFrame`
 * is a function of (state, frame) and never writes to the state it was given.
 *
 * ## What a bubble holds
 *
 * [StreamBucket.text] and [StreamBucket.reasoning] are the two growing strings; `tools` is the
 * ordered list of steps, because a row that disappeared between batches would flicker. `seq` is
 * the last sequence seen, and a frame at or below it is a duplicate from a reconnecting relay and
 * is dropped rather than appended twice.
 *
 * ## When a bubble goes
 *
 * A `stream` frame is fire and forget, and the round's final text arrives as an ordinary synced
 * message, so a `done` round's bubble is kept a short grace while its reply lands and dropped
 * after. A round that went quiet without any `done` at all is bounded by [STREAM_QUIET_MS], so a
 * device that crashed mid-run cannot leave a line spinning under a conversation that ended.
 */
object StreamBuckets {

    /** How long a finished round's bubble is kept while its final text lands as a synced message. */
    const val STREAM_GRACE_MS = 20_000L

    /** How long a round that never said `done` may keep a bubble. */
    const val STREAM_QUIET_MS = 2 * 60_000L

    /** One tool step as the bubble shows it. */
    data class StreamTool(
        val name: String,
        val stage: String,
        val summary: String,
        val ok: Boolean,
        /**
         * How much of the turn's text had been written when this step happened. A turn is not one
         * block of prose followed by a list of steps: it reads, calls a tool, says what it found,
         * calls another. The bubble keeps that order by cutting the text at these marks, so a step
         * sits where it happened instead of every step piling up after the last paragraph.
         */
        val textAt: Int,
    ) {
        /** The row as it reads: the tool's own name and what it found, never re-worded here. */
        val line: String get() = if (summary.isBlank()) name else "$name \u00b7 $summary"
    }

    /** One turn in progress: the growing bubble for one `cid` and `round`. */
    data class StreamBucket(
        val cid: String,
        val round: String,
        /** The device running it, from the round's first frame. */
        val from: String,
        /** The highest `seq` merged so far; 0 before the first frame. */
        val seq: Int,
        val text: String,
        val reasoning: String,
        val tools: List<StreamTool>,
        val done: Boolean,
        /** When the last frame arrived, so a quiet, unterminated round can be aged out. */
        val at: Long,
    ) {
        /** Whether this round has anything to draw at all: words, reasoning, or a step. */
        val drawable: Boolean get() = text.isNotBlank() || reasoning.isNotBlank() || tools.isNotEmpty()
    }

    /** The key a round's bucket lives under. The conversation is in it so two chats cannot collide. */
    fun key(cid: String, round: String): String = "$cid\u0000$round"

    /**
     * One batch off the wire, or null when the object is not one.
     *
     * Every field is unknown until checked, the way [io.github.nanomuse.hub.HubClient] reads its
     * own frames: a frame that is not a `stream`, or carries neither a conversation nor a round, or
     * has nothing to draw at all, is left alone. That last part is the design's "an older client
     * ignores a frame it does not know" taken one step further, so a newer relay's field this build
     * does not understand is dropped rather than half-drawn.
     *
     * A frame with only `done` is kept: it closes a round whose opening batch was lost.
     */
    fun read(raw: JSONObject?): StreamFrame? {
        if (raw == null) return null
        if (raw.optString("type") != "stream") return null
        val cid = raw.optString("cid").trim()
        val round = raw.optString("round").trim()
        if (cid.isEmpty() || round.isEmpty()) return null
        val delta = raw.optString("delta").takeIf { raw.has("delta") }
        val reasoning = raw.optString("reasoning").takeIf { raw.has("reasoning") }
        val tool = readTool(raw.optJSONObject("tool"))
        val done = raw.optBoolean("done", false)
        if (delta.isNullOrEmpty() && reasoning.isNullOrEmpty() && tool == null && !done) return null
        val seq = raw.optInt("seq", 0)
        return StreamFrame(
            cid = cid,
            round = round,
            from = raw.optString("from"),
            seq = if (seq > 0) seq else 0,
            delta = delta,
            reasoning = reasoning,
            tool = tool,
            done = done,
        )
    }

    private fun readTool(raw: JSONObject?): StreamFrame.Tool? {
        if (raw == null) return null
        val name = raw.optString("name").trim()
        if (name.isEmpty()) return null
        return StreamFrame.Tool(
            name = name,
            stage = if (raw.optString("stage") == "result") "result" else "call",
            summary = raw.optString("summary"),
            ok = !raw.has("ok") || raw.optBoolean("ok"),
        )
    }

    /**
     * Merge one frame into the account's streams. Pure: the same (buckets, frame) gives the same
     * answer, and the map handed in is never written to.
     *
     * A frame is dropped when it names no conversation or round, is a duplicate (`seq` at or below
     * the round's last), or arrives after the round said it was done. `done` on a frame that also
     * carries the last batch is applied in the same step, so the final text is never lost to the
     * ordering.
     */
    fun apply(
        buckets: Map<String, StreamBucket>,
        frame: StreamFrame,
        at: Long = System.currentTimeMillis(),
    ): Map<String, StreamBucket> {
        val key = key(frame.cid, frame.round)
        val previous = buckets[key]
        if (previous != null && (previous.done || frame.seq <= previous.seq)) return buckets

        // A frame that is only a close still has to reach the bubble, so a missing bucket is made
        // here rather than dropped: a `done` for a round whose opening batch was lost ends it.
        val text = (previous?.text ?: "") + (frame.delta ?: "")
        val base = previous ?: StreamBucket(
            cid = frame.cid,
            round = frame.round,
            from = frame.from,
            seq = 0,
            text = "",
            reasoning = "",
            tools = emptyList(),
            done = false,
            at = at,
        )
        val batch = base.copy(
            // The round keeps the device it opened with: `from` names whose turn this is, and a
            // later batch forwarded from elsewhere must not re-label a bubble mid-flight.
            seq = maxOf(base.seq, frame.seq),
            text = text,
            reasoning = if (frame.reasoning != null) base.reasoning + frame.reasoning else base.reasoning,
            // The step is marked where the text stood when it arrived, so the bubble can keep the
            // turn's own order: prose, the step, the prose after it.
            tools = if (frame.tool != null) base.tools + toolOf(frame.tool, text.length) else base.tools,
            done = frame.done,
            at = at,
        )
        return buckets + (key to batch)
    }

    private fun toolOf(tool: StreamFrame.Tool, textAt: Int): StreamTool = StreamTool(
        name = tool.name.trim().ifEmpty { tool.name },
        stage = tool.stage,
        summary = tool.summary.trim(),
        ok = tool.ok,
        textAt = textAt,
    )

    /** The conversation's rounds, newest batch first: what the chat draws, in the order to read it. */
    fun of(buckets: Map<String, StreamBucket>, cid: String): List<StreamBucket> =
        buckets.values
            .filter { it.cid == cid }
            .sortedWith(compareByDescending<StreamBucket> { it.at }.thenBy { it.round })

    /**
     * The rounds still worth drawing: the running ones, and a finished round only while the final
     * text is on its way into the conversation. A round that went quiet without a `done` ages out
     * after [STREAM_QUIET_MS], so a spinner cannot outlive the run it stood for.
     *
     * A round from this phone is left out (the relay does not echo the sender, but a bucket kept
     * across a reconnection could name it), as is one with nothing in it.
     */
    fun live(
        buckets: Map<String, StreamBucket>,
        cid: String,
        selfId: String,
        now: Long = System.currentTimeMillis(),
    ): List<StreamBucket> = of(buckets, cid)
        .filter { it.round.isNotEmpty() && it.from != selfId }
        .filter { it.drawable }
        .filter { now - it.at < (if (it.done) STREAM_GRACE_MS else STREAM_QUIET_MS) }

    /** Drop the rounds that have been settled or have gone quiet (see [live]). */
    fun prune(
        buckets: Map<String, StreamBucket>,
        now: Long = System.currentTimeMillis(),
    ): Map<String, StreamBucket> {
        val kept = buckets.filterValues { now - it.at < (if (it.done) STREAM_GRACE_MS else STREAM_QUIET_MS) }
        return if (kept.size == buckets.size) buckets else kept
    }

    /** One block of a turn, in the order it happened: a run of prose, or one step. */
    sealed interface Block {
        data class Text(val markdown: String) : Block
        data class Step(val line: String, val bad: Boolean) : Block
    }

    /**
     * A turn's prose and its steps, interleaved the way they happened. Each step carries how much
     * text had been written when it arrived ([StreamTool.textAt]), so cutting the text at those
     * marks puts every step back where it belongs. A step whose mark falls past the end of the text
     * (the words for it have not arrived yet) is left for the end, where it reads once they do.
     */
    fun blocks(bucket: StreamBucket): List<Block> {
        val text = bucket.text
        val steps = bucket.tools
            .map { Triple(it.textAt.coerceIn(0, text.length), it.line, it.stage == "result" && !it.ok) }
            .sortedBy { it.first }
        val out = mutableListOf<Block>()
        var cursor = 0
        for ((mark, line, bad) in steps) {
            if (mark > cursor) out += Block.Text(text.substring(cursor, mark))
            out += Block.Step(line, bad)
            cursor = maxOf(cursor, mark)
        }
        if (cursor < text.length) out += Block.Text(text.substring(cursor))
        return out.filter { it is Block.Step || (it as Block.Text).markdown.isNotBlank() }
    }

    /** A `stream` frame's body, the fields the relay forwards. */
    data class StreamFrame(
        val cid: String,
        val round: String,
        val from: String,
        val seq: Int,
        val delta: String?,
        val reasoning: String?,
        val tool: Tool?,
        val done: Boolean,
    ) {
        /** A step of the turn: the tool it called, or what that tool returned. */
        data class Tool(val name: String, val stage: String, val summary: String, val ok: Boolean)
    }
}
