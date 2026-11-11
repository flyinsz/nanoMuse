package io.github.nanomuse.sync

import com.openminis.app.ui.chat.AssistantBlock
import com.openminis.app.ui.chat.ToolBlockStatus
import org.json.JSONObject

class RemoteTaskReply(private val deviceId: String) {
    var blocks: List<AssistantBlock> = emptyList()
        private set
    private var finished = false
    private var serial = 0
    val text: String get() = blocks.filter { it.isText }.joinToString("\n\n") { it.content }

    // nanoMuse: the run happening on the other device, live (executor handoff v2 §4.4). The
    // runtime relays its own bus frames as `stream_start` / `delta` / `reasoning_delta` /
    // `stream_end` (nanomuse/hub/service.py `_forward_stream`), and a turn handed over with
    // `@<device>` reaches this phone as those. They were dropped here — the `when` below knew
    // only `text` / `tool` / `tool_result` — so the person watched a silent wait and then the
    // whole answer at once, while the device that ran it streamed the whole time. The pieces
    // grow the same `text` / `thinking` blocks a local run uses; the final `text` event still
    // replaces them, so what is persisted stays the answer alone.
    private var streamId: String = ""
    private var streamText: String = ""
    private var streamReasoning: String = ""

    fun event(body: JSONObject) {
        if (finished) return
        when (body.optString("stage")) {
            "text" -> body.optString("text").takeIf { it.isNotBlank() }?.let(::setText)
            "stream_start" -> {
                streamId = body.optString("id")
                streamText = ""
                streamReasoning = ""
            }
            "delta" -> {
                val piece = body.optString("text")
                if (piece.isEmpty()) return
                streamText += piece
                setStreamText(streamText)
            }
            "reasoning_delta" -> {
                val piece = body.optString("text")
                if (piece.isEmpty()) return
                streamReasoning += piece
                setStreamReasoning(streamReasoning)
            }
            "stream_end" -> {
                streamId = ""
                streamText = ""
                streamReasoning = ""
            }
            "tool" -> {
                val id = "$deviceId:${body.optString("id").ifBlank { "step-${serial++}" }}"
                if (blocks.any { it.id == id }) return
                blocks = blocks + AssistantBlock(
                    id = id, kind = "tool_use", toolName = body.optString("name"),
                    toolTitle = body.optString("summary").ifBlank { body.optString("name") },
                    toolStatus = ToolBlockStatus.RUNNING, startTimeMs = System.currentTimeMillis(),
                )
            }
            "tool_result" -> {
                val id = "$deviceId:${body.optString("id")}"
                blocks = blocks.map { block ->
                    if (block.id != id) block else block.copy(
                        content = body.optString("summary"),
                        toolStatus = if (body.optBoolean("ok", true)) ToolBlockStatus.SUCCESS else ToolBlockStatus.FAILED,
                        durationMs = (System.currentTimeMillis() - block.startTimeMs).coerceAtLeast(0),
                    )
                }
            }
        }
    }

    private fun setText(text: String) {
        val last = blocks.lastOrNull()
        blocks = if (last?.isText == true) blocks.dropLast(1) + last.copy(content = text)
        else blocks + AssistantBlock(id = "$deviceId:text-${serial++}", kind = "text", content = text)
    }

    /**
     * nanoMuse: the growing words of the run on the other device. Keyed by the stream the runtime
     * opened, so a second turn in the same chat takes over the same block rather than piling a new
     * one beside it; the final `text` event replaces the block's content with the whole answer.
     */
    private fun setStreamText(text: String) {
        val id = "$deviceId:stream:${streamId.ifBlank { "text" }}"
        val existing = blocks.indexOfFirst { it.id == id }
        val block = AssistantBlock(id = id, kind = "text", content = text)
        blocks = if (existing >= 0) blocks.toMutableList().also { it[existing] = block } else blocks + block
    }

    /** The thinking of the run, folded by the same `thinking` block a local run uses. */
    private fun setStreamReasoning(text: String) {
        val id = "$deviceId:stream:thinking:${streamId.ifBlank { "text" }}"
        val existing = blocks.indexOfFirst { it.id == id }
        val block = AssistantBlock(id = id, kind = "thinking", content = text)
        blocks = if (existing >= 0) blocks.toMutableList().also { it[existing] = block } else blocks + block
    }

    fun finish(text: String, failed: Boolean = false, stopped: Boolean = false): Boolean {
        if (finished) return false
        finished = true
        blocks = blocks.map { block ->
            if (block.toolStatus != ToolBlockStatus.RUNNING) block else block.copy(
                toolStatus = if (failed) ToolBlockStatus.FAILED else ToolBlockStatus.CANCELLED,
                durationMs = (System.currentTimeMillis() - block.startTimeMs).coerceAtLeast(0),
            )
        }
        // nanoMuse: the streamed pieces are the same words the final answer carries, so they go
        // before it is written — otherwise the answer would read twice (once as the last delta,
        // once as the result), and `text` is what `nmAppendAssistantLine` persists and syncs.
        blocks = blocks.filterNot { it.id.startsWith("$deviceId:stream:") }
        if (failed || stopped) blocks = blocks + AssistantBlock(id = "$deviceId:end-${serial++}", kind = "text", content = text)
        else setText(text)
        return true
    }
    companion object {
        fun answer(body: JSONObject): String? = body.optString("text").ifBlank { body.optString("answer") }.trim().takeIf { it.isNotEmpty() }
    }
}
