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
    enum class Issue { AMBIGUOUS, OFFLINE, ATTACHMENTS, BUSY, FAILED, UNKNOWN_DEVICE }
    interface Task {
        val text: String
        val blocks: List<AssistantBlock>
        val failed: Boolean
        val stopped: Boolean get() = false
        // nanoMuse: true when another device ran this turn on the chat's own conversation, so
        // the answer is *that* device's row — it pushes it, and this phone receives it by pull
        // (C8: a row written on another device is not this phone's turn). The host must not
        // write a second copy of it, which is what put the same answer in the chat twice.
        val handedOver: Boolean get() = false
        // nanoMuse: whether the far device's answer has already landed in this chat, so a
        // failure here is not worth a line. Measured: the phone's hub socket dropped mid-turn
        // (a reconnect), the far device finished and pushed its answer anyway, and the call
        // timed out fifteen minutes later — the chat then read "NAS-by-Donny 未回复：现在没有连上
        // 中继" *underneath* the answer that had arrived. The host asks this before writing the
        // failure, so a turn that did finish is never reported as unanswered.
        suspend fun answerAlreadyLanded(sessionId: String): Boolean = false
        // nanoMuse: [mid] is the local row id of the line being handed over, so the device that
        // runs it writes that row rather than one of its own (executor handoff v2 §E).
        suspend fun run(sessionId: String, mid: String, update: () -> Unit)
        fun stop()
    }
    interface Host {
        val busy: Boolean
        fun setBusy(value: Boolean)
        fun error(issue: Issue, device: String = "")
        fun clearDraft()
        fun restoreDraft(text: String)
        suspend fun session(): String
        // nanoMuse: writes the asked line into the local chat and answers with that row's id.
        // The id goes on as `mid` when the turn is handed over, so the device that runs it
        // writes that same row instead of minting one of its own — one line, one bubble, one
        // relay row (executor handoff v2 §E, "单 `mid` 直通"). Without it a handed-over turn
        // arrives twice: the far device's own row, and this phone's local one (§C8).
        suspend fun user(sessionId: String, text: String): String
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
        // nanoMuse: whether a leading-`@` line that resolved to no device names *this* phone
        // (§4.2 rule 3). The bridge cannot decide it — this phone is not in the account's device
        // list — so the host answers. False means the line named something nobody can reach (a
        // device that is offline, or a name that is not one), and the bridge refuses it rather
        // than quietly running it here: the person asked for that device, and answering from this
        // phone's memory is a different conversation (§4.2).
        fun namesSelf(text: String): Boolean = true
        // nanoMuse: a line handed to another device makes *that* device the chat's owner from
        // now on (§4.1: the owner is the device that ran the last turn). The host records it
        // the moment the task goes, so the composer shows `@<that device>` at once and the
        // next line — with no `@` — goes there too, instead of waiting a pull cycle for the
        // relay to report back and running here in the meantime.
        fun tookOwnerThere(deviceId: String, deviceName: String) {}
    }
    private class Active(val id: String, val task: Task) { var job: Job? = null }
    private var active: Active? = null

    /**
     * The name a leading `@` addressed, as the person typed it — up to the first space or
     * punctuation, so `@//nas/ show me` reports `//nas/` and `@NAS-by-Donny build it` reports
     * `NAS-by-Donny`. Only for the refusal message: the router works on device names, not on
     * this. An empty result is left empty; the caller's string then has nothing to name.
     */
    private fun addressedName(text: String): String {
        val rest = text.trimStart().removePrefix("@")
        val end = rest.indexOfFirst { it.isWhitespace() || it in NAME_BREAKS }
        return (if (end < 0) rest else rest.substring(0, end)).trim()
    }

    /** Where a name stops for [addressedName]: the same punctuation the router accepts. */
    private val NAME_BREAKS = charArrayOf(':', '：', ',', '，', ';', '；')

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
        // nanoMuse: still nobody addressed. A line that names this phone (`@本机`) runs here, as
        // upstream did. A leading `@` that names anything else is a device the person asked for
        // and the account could not reach — offline, or a name no device answers to. Running it
        // here would answer from this phone's memory a conversation it never held, which is the
        // bug that made an `@` to an unreachable NAS come back with the phone's own words (§4.2).
        // It is refused instead, and the person is told.
        if (route == RemoteDeviceRoute.None) {
            val addressed = text.trimStart().startsWith("@")
            if (!addressed) return false
            val self = host.namesSelf(text)
            if (self) host.takeOwnerHere(text)
            if (self) return false
            // the name as the person typed it, so the message says which `@` reached nobody
            // ("there is no reachable device called 「//nas/」"); without it the line reads with
            // an empty hole where the name should be
            return refuse(text, Issue.UNKNOWN_DEVICE, addressedName(text))
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
                val mid = host.user(sessionId, text)
                userShown = true
                host.started(sessionId)
                host.show(id, run.task)
                run.task.run(sessionId, mid) { if (active === run) host.show(id, run.task) }
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
