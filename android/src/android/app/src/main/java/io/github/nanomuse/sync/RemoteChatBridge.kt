package io.github.nanomuse.sync

import com.openminis.app.ui.chat.AssistantBlock
import io.github.nanomuse.hub.Device
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID

/** The small host adapter keeps task lifecycle out of the upstream chat view model. */
class RemoteChatBridge(
    private val scope: CoroutineScope,
    private val host: Host,
    private val newTask: (Device, String, String) -> Task,
) {
    enum class Issue { AMBIGUOUS, OFFLINE, ATTACHMENTS, BUSY, FAILED }
    interface Task {
        val text: String
        val blocks: List<AssistantBlock>
        val failed: Boolean
        val stopped: Boolean get() = false
        suspend fun run(sessionId: String, update: () -> Unit)
        fun stop()
    }
    interface Host {
        val busy: Boolean
        fun setBusy(value: Boolean)
        fun error(issue: Issue, device: String = "")
        fun clearDraft()
        fun restoreDraft(text: String)
        suspend fun session(): String
        suspend fun user(sessionId: String, text: String)
        fun started(sessionId: String) {}
        fun ended(sessionId: String, completed: Boolean) {}
        fun show(id: String, task: Task)
        suspend fun finish(sessionId: String, id: String, task: Task)
        fun afterTurn()
        // nanoMuse: the id of the device holding this chat's context, when it is not this phone
        // (executor handoff v2 §4.2). Null for a chat the relay never named a device for — the
        // ordinary path, which runs here. Only the id crosses this boundary: the bridge resolves
        // it against the device list it was handed, so an offline owner falls back to this phone.
        fun ownerId(): String? = null
        // nanoMuse: re-read the owner map from the database before routing a line (§4.2). The
        // in-memory map is filled at init and after a pull that touched chats; without this a
        // send can route on an owner another device already moved. Suspend, so the route below
        // judges the value the database holds rather than a stale one.
        suspend fun refreshOwner() {}
        // nanoMuse: what that owner is called, for the "it is not answering" message (§4.2).
        fun ownerName(): String? = null
        // nanoMuse: a line that names this phone (`@本机`, or this device's own name) takes the
        // context back here (§4.2 rule 3 "`@本机` 必须可用"), so the composer stops offering the
        // other device. The bridge cannot tell `@本机` from an unknown `@nobody` — both resolve to
        // no device — so it hands the text over and the host judges, which keeps an unknown `@`
        // from moving the owner.
        fun takeOwnerHere(text: String) {}
        // nanoMuse: a line handed to another device makes *that* device the chat's owner from
        // now on (§4.1: the owner is the device that ran the last turn). The host records it
        // the moment the task goes, so the composer shows `@<that device>` at once and the
        // next line — with no `@` — goes there too, instead of waiting a pull cycle for the
        // relay to report back and running here in the meantime.
        fun tookOwnerThere(deviceId: String, deviceName: String) {}
    }
    private class Active(val id: String, val task: Task) { var job: Job? = null }
    private var active: Active? = null

    private fun refuse(text: String, issue: Issue, device: String = ""): Boolean {
        // The composer clears its field before dispatch; a refusal must put it back.
        host.restoreDraft(text)
        host.error(issue, device)
        return true
    }

    /** True means addressed here, including a refusal. It must not fall into the local model. */
    suspend fun send(text: String, devices: List<Device>, attachments: Boolean, compacting: Boolean): Boolean {
        // nanoMuse: the owner may have moved on another device since this screen opened, and the
        // in-memory map only catches up on the pull cycle — so a follow-up meant for the NAS was
        // judged ownerless and ran here (executor handoff v2 §4.2). Ask the database before
        // routing: one indexed query, awaited, so the route below judges the current owner.
        // Best effort; a failure leaves the map as it was.
        host.refreshOwner()
        var route = RemoteDeviceRoute.resolve(text, devices)
        // nanoMuse: with no `@` at all, the recent owner runs it (executor handoff v2 §4.2) — the
        // one behaviour change from upstream, where no mention always meant this phone. Only a
        // line that addresses nobody takes this path: `@本机` (and any unknown `@`) also resolves
        // to None, and those the person meant for this phone, so the owner must not take them.
        if (route == RemoteDeviceRoute.None && !text.trimStart().startsWith("@")) {
            val ownerId = host.ownerId() ?: return false
            val known = devices.firstOrNull { it.id == ownerId }
            // nanoMuse: the owner has gone (offline, or dropped from the account). Running here
            // would answer with this phone's memory, which never held that chat's context — the
            // person must be told, not quietly given a different conversation. (§4.2)
            if (known == null) return refuse(text, Issue.OFFLINE, host.ownerName() ?: ownerId)
            route = RemoteDeviceRoute.Selected(known, text)
        }
        // nanoMuse: still nobody addressed — nobody to hand it to, so this phone runs it (upstream's
        // own path). Reached by `@本机`/an unknown `@` (meant for this phone) and by a chat with no
        // owner. It must not fall into the refusal below, which would wrongly error on `@本机`.
        if (route == RemoteDeviceRoute.None) {
            // nanoMuse: a line that names this phone takes the context back (§4.2 rule 3), so the
            // composer stops offering the other device and the next line stays here. The host
            // judges the text, so an unknown `@nobody` leaves the owner where it was.
            if (text.trimStart().startsWith("@")) host.takeOwnerHere(text)
            return false
        }
        if (route !is RemoteDeviceRoute.Selected) return refuse(text, Issue.AMBIGUOUS)
        if (host.busy || compacting) return refuse(text, Issue.BUSY)
        if (!route.device.online) return refuse(text, Issue.OFFLINE, route.device.name)
        if (attachments) return refuse(text, Issue.ATTACHMENTS)
        if (route.text.isBlank()) { host.restoreDraft(text); return true }
        // nanoMuse: the context moves to that device as the task goes (§4.1) — recorded before
        // the run so the placeholder and the next route already say so. A `@<device>` line is
        // the one way to hand the turn over, so this is the right place for it.
        host.tookOwnerThere(route.device.id, route.device.name)
        val id = UUID.randomUUID().toString()
        val run = Active(id, newTask(route.device, route.text, id))
        active = run
        host.setBusy(true)
        host.clearDraft()
        run.job = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            var sessionId: String? = null
            var userShown = false
            var taskReturned = false
            try {
                sessionId = host.session()
                host.user(sessionId, text)
                userShown = true
                host.started(sessionId)
                host.show(id, run.task)
                run.task.run(sessionId) { if (active === run) host.show(id, run.task) }
                taskReturned = true
            } catch (e: CancellationException) {
                run.task.stop()
                throw e
            } catch (_: Exception) {
                host.error(Issue.FAILED, route.device.name)
            } finally {
                withContext(NonCancellable) {
                    var saved = false
                    try {
                        if (userShown && sessionId != null) {
                            host.finish(sessionId, id, run.task)
                            saved = true
                        }
                        else host.restoreDraft(text)
                    } catch (_: Exception) {
                        host.error(Issue.FAILED, route.device.name)
                    } finally {
                        if (userShown && sessionId != null) {
                            host.ended(sessionId, saved && taskReturned && !run.task.failed && !run.task.stopped)
                        }
                        if (active === run) {
                            active = null
                            host.setBusy(false)
                            host.afterTurn()
                        }
                    }
                }
            }
        }
        return true
    }

    fun cancel(): Boolean {
        val run = active ?: return false
        run.task.stop()
        host.show(run.id, run.task)
        run.job?.cancel()
        return true
    }
}
