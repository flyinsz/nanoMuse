package io.github.nanomuse.sync

import org.json.JSONObject

/**
 * One batch of a turn running on another device, as the relay fans it out (executor handoff v2,
 * `docs/tasks/executor-handoff-v2.md` §C).
 *
 * The relay broadcasts a `stream` frame every 200-250 ms while a turn runs elsewhere: the words
 * written so far, the reasoning, and a step each time a tool is called. `delta` and `reasoning`
 * are batches to append; `tool` is one event of its own, not a batch; `done` closes the round.
 * A device that was away for a run gets the final text over sync instead — nothing is replayed.
 *
 * This is the wire shape and nothing more: [read] is a pure function of a frame, so it can be
 * checked with JUnit and no Android runtime. Keeping the state and the drawing is the caller's.
 */
data class StreamBatch(
    val cid: String,
    /** The run's id on the sending device: what tells two turns of one chat apart (§4.4). */
    val round: String,
    /** The device running the turn. */
    val from: String,
    /** The relay's display name for [from]; empty when it has none. */
    val deviceName: String,
    /** The batch's order number within the round; 0 when the sender gave none. */
    val seq: Int,
    /** The words written since the last batch, or null when this batch carried none. */
    val delta: String?,
    /** The reasoning written since the last batch, or null. */
    val reasoning: String?,
    /** A step of the turn — a tool call or a tool's result — or null. */
    val tool: Tool?,
    /** The round is over. */
    val done: Boolean,
) {
    /** A step of the turn: the tool it called, or what that tool returned. */
    data class Tool(val name: String, val stage: String, val summary: String, val ok: Boolean)

    companion object {
        const val CALL = "call"
        const val RESULT = "result"

        /**
         * A frame off the hub, or null when it is not one to draw.
         *
         * Every field is checked the way [io.github.nanomuse.hub.HubClient] reads its own frames:
         * a frame that is not a `stream`, or names no conversation or round, or has nothing to
         * draw (no delta, no reasoning, no tool, no `done`), is left alone. That is the design's
         * "an older client ignores a frame it does not know" taken a step further, so a newer
         * relay's field this build does not understand is dropped rather than half-drawn.
         *
         * A frame carrying only `done` is kept: it closes a round whose opening batch was lost.
         */
        fun read(raw: JSONObject?): StreamBatch? {
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
            return StreamBatch(
                cid = cid,
                round = round,
                from = raw.optString("from"),
                deviceName = raw.optString("device_name"),
                seq = if (seq > 0) seq else 0,
                delta = delta,
                reasoning = reasoning,
                tool = tool,
                done = done,
            )
        }

        private fun readTool(raw: JSONObject?): Tool? {
            if (raw == null) return null
            val name = raw.optString("name").trim()
            val stage = raw.optString("stage").trim()
            if (name.isEmpty() && stage.isEmpty()) return null
            return Tool(
                name = name,
                stage = if (stage == RESULT) RESULT else CALL,
                summary = raw.optString("summary"),
                ok = !raw.has("ok") || raw.optBoolean("ok"),
            )
        }
    }
}

/**
 * The runs in flight, folded from the batches as they arrive: one [Bucket] per round, so two
 * turns of the same chat cannot overwrite each other (§4.4) — which a map keyed by conversation
 * alone would let them do.
 *
 * Pure: [merge] is a function of (state, batch) and never writes to the state it was given, so
 * the fold can be checked without a renderer.
 */
object Streams {
    /** How long a round is drawn after its last batch: a `done` round waits for its final text
     * to land as a synced message, a quiet one is bounded so a crashed device cannot leave a
     * line spinning forever. */
    const val GRACE_MS = 20_000L
    const val QUIET_MS = 2 * 60_000L

    /** One round in progress: the growing text, the reasoning and the steps, in order. */
    data class Bucket(
        val cid: String,
        val round: String,
        /** The device that opened the round; a later batch must not re-label it mid-flight. */
        val from: String,
        val deviceName: String,
        /** The highest `seq` merged; 0 before the first batch. */
        val seq: Int,
        val text: String,
        val reasoning: String,
        val tools: List<StreamBatch.Tool>,
        val done: Boolean,
        /** When the last batch arrived, so a stale round can be aged out. */
        val at: Long,
    ) {
        /** Whether this round has anything to draw at all. */
        val drawable: Boolean get() = text.isNotBlank() || reasoning.isNotBlank() || tools.isNotEmpty()
    }

    /**
     * One batch into the rounds of a chat, keyed by `round`. A batch that names no round, is a
     * duplicate (its `seq` at or below the round's last), or arrives after the round said `done`
     * is dropped. A batch carrying `done` and the last words in one frame applies both, so the
     * closing words are never lost to the order.
     */
    fun merge(byRound: Map<String, Bucket>, batch: StreamBatch, at: Long = System.currentTimeMillis()): Map<String, Bucket> {
        if (batch.round.isEmpty()) return byRound
        val previous = byRound[batch.round]
        if (previous != null && (previous.done || (batch.seq in 1..previous.seq))) return byRound
        // a `done` whose opening batch was lost still has to reach the bubble
        val base = previous ?: Bucket(
            cid = batch.cid,
            round = batch.round,
            from = batch.from,
            deviceName = batch.deviceName,
            seq = 0,
            text = "",
            reasoning = "",
            tools = emptyList(),
            done = false,
            at = at,
        )
        val merged = base.copy(
            seq = maxOf(base.seq, batch.seq),
            text = base.text + (batch.delta ?: ""),
            reasoning = if (batch.reasoning != null) base.reasoning + batch.reasoning else base.reasoning,
            tools = if (batch.tool != null) base.tools + batch.tool else base.tools,
            done = batch.done,
            at = at,
        )
        return byRound + (batch.round to merged)
    }

    /** The rounds of one chat still worth drawing, newest first; a round this phone ran is left out. */
    fun live(byRound: Map<String, Bucket>, selfId: String, now: Long = System.currentTimeMillis()): List<Bucket> =
        byRound.values
            .filter { it.from != selfId && it.drawable }
            .filter { now - it.at < (if (it.done) GRACE_MS else QUIET_MS) }
            .sortedByDescending { it.at }

    /** Drop the rounds that have settled or gone quiet (see [live]). */
    fun prune(byRound: Map<String, Bucket>, now: Long = System.currentTimeMillis()): Map<String, Bucket> {
        val kept = byRound.filterValues { now - it.at < (if (it.done) GRACE_MS else QUIET_MS) }
        return if (kept.size == byRound.size) byRound else kept
    }
}
