package io.github.nanomuse.sync

import android.content.Context
import com.openminis.app.R
import com.openminis.app.ui.chat.AssistantBlock
import io.github.nanomuse.hub.Device
import io.github.nanomuse.hub.Hub
import io.github.nanomuse.hub.HubErrors
import io.github.nanomuse.reach.Computers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runInterruptible
import org.json.JSONObject

/** Owns a remote reply, not a local agent run. All UI callbacks run in the caller's scope. */
class RemoteTaskChat(
    private val context: Context,
    private val device: Device,
    text: String,
    val callId: String,
) : RemoteChatBridge.Task {
    private val task = RemoteDeviceTask(device, text, Computers.uiLanguage(context), callId)
    private val reply = RemoteTaskReply(device.id)
    override var failed = false
        private set
    override var stopped = false
        private set

    // nanoMuse: the reply itself, with no attribution glued on. A "来自 飞牛深圳\n\n" prefix used
    // to ride here, and this is the string that gets *persisted* (`nmAppendAssistantLine`) and
    // then synced to every other device — so the attribution became part of the answer
    // everywhere, in the reply's own bubble.
    //
    // The device line that used to head these blocks is gone: it was drawn as an `info` block
    // (`FallbackInfoBlock`, rules either side) and appeared over every handed-over turn, so a
    // back-and-forth read as a stack of separators. The device is named once, by the composer's
    // own placeholder (`@<device>`, `rememberExecutorPlaceholder`), which is where the person
    // looks to see whose turn the next line is — and a change of writer in the chat itself is
    // what the sync caption marks (`NmSyncCaption`).
    override val text: String get() = reply.text
    override val blocks: List<AssistantBlock> get() = reply.blocks

    override fun stop() {
        stopped = true
        reply.finish(context.getString(R.string.nm_coding_stopped), stopped = true)
    }

    override suspend fun run(sessionId: String, update: () -> Unit) {
        // nanoMuse: name the chat before the call goes. A cid is the only thing both sides
        // call this conversation by, so it is what makes the far end run the turn on the
        // context it already holds instead of a fresh `From <device>` thread (§E). Best
        // effort: a chat with no cid yet keeps the older behaviour rather than failing.
        task.cid = ConversationSync.cidOf(sessionId) ?: ""
        try {
            exchange(sessionId, update)
        } catch (e: CancellationException) {
            stop()
            throw e
        } catch (e: Exception) {
            failed = true
            reply.finish(context.getString(R.string.nm_remote_failed, device.name, HubErrors.describe(context, e)), failed = true)
        } finally {
            update()
        }
    }

    private suspend fun exchange(sessionId: String, update: () -> Unit): Unit = coroutineScope {
        val approvals = RemoteTaskApprovals(this, sessionId, device.name, approve = { id, allow ->
            runInterruptible(Dispatchers.IO) {
                Hub.call(device.id, "approve", JSONObject().put("approval_id", id).put("allow", allow), 30_000)
            }
        })
        try {
            update()
            val result = task.run(
                call = { id, to, action, args, event ->
                    args.put("from", Hub.name(context))
                    runInterruptible(Dispatchers.IO) {
                        Hub.callWithId(id, to, action, args, io.github.nanomuse.hub.HubClient.TASK_TIMEOUT_MS, event)
                    }
                },
                onEvent = { body -> approvals.event(body); reply.event(body); update() },
                stop = { id -> runInterruptible(Dispatchers.IO) {
                    Hub.call(device.id, "stop", JSONObject().put("call", id), io.github.nanomuse.hub.HubClient.TASK_STOP_TIMEOUT_MS)
                }; Unit },
            )
            val answer = RemoteTaskReply.answer(result)
            failed = answer == null
            val final = answer ?: context.getString(R.string.nm_remote_no_answer, device.name)
            reply.finish((listOf(final) + approvals.notices).joinToString("\n\n"), failed)
        } finally {
            approvals.close()
        }
    }
}
