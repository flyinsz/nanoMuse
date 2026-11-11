package io.github.nanomuse.sync

import io.github.nanomuse.hub.Device
import io.github.nanomuse.hub.HubException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

class RemoteDeviceTask(
    private val device: Device,
    private val text: String,
    private val language: String,
    val callId: String,
    // nanoMuse: the relay's own id for the chat this line belongs to. The runtime runs a
    // handed-over turn on the conversation it already holds (§E), and a cid is the only name
    // both sides share. Left blank, it opens a fresh `From <device>` thread — a different
    // conversation, and one whose live output does not travel back to the asker (§4.4).
    // Filled just before the call, once the local session id is known.
    var cid: String = "",
) {
    suspend fun run(
        call: suspend (String, String, String, JSONObject, (JSONObject) -> Unit) -> JSONObject,
        onEvent: suspend (JSONObject) -> Unit,
        stop: suspend (String) -> Unit,
    ): JSONObject {
        if (!device.online) throw HubException("device_offline", "the destination is offline")
        if ("task" !in device.actions) throw HubException("unknown_action", "the destination does not accept tasks")
        try {
            return coroutineScope {
                val events = Channel<JSONObject>(Channel.UNLIMITED)
                val consumer = launch { for (event in events) onEvent(event) }
                try {
                    val args = JSONObject()
                        .put("text", text).put("language", language).put("stream", true)
                    if (cid.isNotBlank()) args.put("thread", cid).put("handoff", true)
                    val result = call(callId, device.id, "task", args) { events.trySend(it) }
                    events.close()
                    consumer.join()
                    result
                } finally {
                    events.close()
                    consumer.cancel()
                }
            }
        } catch (e: Exception) {
            withContext(NonCancellable) { runCatching { stop(callId) } }
            throw e
        }
    }
}
