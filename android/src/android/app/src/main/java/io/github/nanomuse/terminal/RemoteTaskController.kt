package io.github.nanomuse.terminal

import android.content.Context
import io.github.nanomuse.guard.GateOutcome
import io.github.nanomuse.guard.GuardKind
import io.github.nanomuse.guard.RiskAssessment
import io.github.nanomuse.guard.RiskClass
import io.github.nanomuse.guard.RiskGate
import io.github.nanomuse.hub.Hub
import io.github.nanomuse.hub.HubException
import io.github.nanomuse.reach.Computers
import io.github.nanomuse.reach.RemoteApprovalKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * A whole task for another device's own Muse, sent straight from the chat instead of through
 * a turn here (`DeviceTargetMention`). The frame is the `task` `docs/hub.md` describes:
 * progress comes back as `event` frames, a question that Muse asks is answered on this
 * phone's usual card, and `stop {conversation}` ends the run.
 *
 * The hub's own limit for a `task` is fifteen minutes (`TASK_TIMEOUT_S` in the runtime) and
 * this asks for exactly that. A caller that gives up before the target does leaves the work
 * running after the person was told it failed, and the answer then has nowhere to land
 * (upstream issue 805).
 */
object RemoteTaskController {
    /** The target's own limit, `nanomuse/hub/service.py` TASK_TIMEOUT_S. */
    const val TIMEOUT_MS = 15 * 60_000L

    /**
     * Hub ids with a task this phone sent and has not heard back from, counted: two chats can
     * have a run out at the same device, and the first one ending must not clear the second's
     * spinner. A run takes minutes, so the device strip wears the spinner while the person waits;
     * the console reads the same "in flight" answer off its own thread list. Kept here because
     * [send] is the one place that knows a run started and the one place that knows it ended,
     * whatever the outcome.
     */
    private val _inFlight = MutableStateFlow<Map<String, Int>>(emptyMap())
    val inFlight: StateFlow<Map<String, Int>> = _inFlight.asStateFlow()

    /** One line of what the run is doing, drawn under the person's message. */
    sealed interface Step {
        data class Running(val text: String) : Step
        data class Done(val text: String, val ok: Boolean) : Step
        data class Said(val text: String) : Step
    }

    /**
     * What became of the run. [Answered.text] is the target's own words and the only thing
     * that counts as an answer; an empty one is [Failed], never a quiet success (issue 718).
     * [Offline] is the one outcome that never left this phone: the device was already known to be
     * away, so nothing was sent and there is no run to wait on. It carries no text of its own —
     * the caller words it in the UI language (there is one, and it is the same sentence the strip's
     * line over the box uses).
     */
    sealed interface Outcome {
        data class Answered(val text: String) : Outcome
        data class Failed(val reason: String) : Outcome
        data object Stopped : Outcome
        data object Offline : Outcome
    }

    /** Whether this phone may run things on another device at all. */
    fun available(context: Context): Boolean = Hub.isConnected && Hub.others(context).isNotEmpty()

    /** Where a card's answer is worked out, off the hub's event thread. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /**
     * The card id for one question: the target's `approval_id`, namespaced so it can never
     * collide with a card this phone raised for something else (its own shell, a computer's
     * pushed question) or with another device's question that happens to carry the same id.
     */
    internal fun cardId(device: Computers.Computer, approvalId: String): String = "task|${device.hubId}|$approvalId"

    /**
     * Sends [text] to [device]'s Muse. Progress arrives through [onStep]; [sessionId] names
     * the chat an approval card belongs to, so a remembered answer is remembered there.
     *
     * Blocking, like every other call to another device (`Computers`): call it from IO.
     * [stopFlag] is read between steps, so a stop ends it as `Outcome.Stopped`; a caller
     * that has no stop of its own passes nothing and the run ends with the answer.
     */
    fun send(
        context: Context,
        device: Computers.Computer,
        conversation: String,
        text: String,
        sessionId: String,
        language: String,
        onStep: (Step) -> Unit,
        stopFlag: () -> Boolean = { false },
        /**
         * The conversation to run on *that device* (C13, impl §D): one it already holds, so the
         * round runs with its full context instead of in a fresh `From <name>`. Blank keeps the
         * old behaviour — a chat is opened for the caller — which is what a caller with nothing
         * to hand over sends. `handoff` goes with it: the round is someone else's, so the device
         * marks it as such rather than treating the sentence as its own person's.
         */
        thread: String = "",
        /**
         * The id this phone already gave the sentence in its own chat (C13, impl §3, "单 mid").
         * The round is written on the target under this same id rather than a fresh one, so the
         * one sentence is one row on the relay and reads once on every device — including the two
         * chats on this phone, whose rows are deduped by it.
         */
        mid: String = "",
    ): Outcome {
        // Contract C13, "owner 离线不发" (docs/session-handoff.md §3): a device the relay has
        // already marked away is not sent to at all. The hub would answer `device_offline` after a
        // round trip, but by then this phone has said the run started, and the person is left
        // watching a disc spin for a sentence that never left — the state C13 forbids. Refusing
        // here, before the counter below, is what keeps the spinner honest: it only ever follows a
        // run that really went out. The `@`-mention and the chat's aim are both resolved against
        // the hub's whole list, sleeping devices included (DeviceStrip.others, DeviceAim), which is
        // why an offline target reaches this call rather than being quietly rerouted.
        if (!device.online) return Outcome.Offline
        // The strip's spinner follows this run from the moment it leaves until its answer, its
        // failure or a stop — the `finally` below is the only exit every one of those shares.
        _inFlight.update { runs -> runs + (device.hubId to (runs[device.hubId] ?: 0) + 1) }
        val body = JSONObject()
            .put("text", text)
            .put("conversation", conversation)
            .put("from", Hub.name(context))
            .put("stream", true)
            .apply { if (language.isNotBlank()) put("language", language) }
            // C13 (impl §D): run this round on the conversation named, with its full context, and
            // say that the round is the caller's. A target that does not know the field ignores
            // it and opens a chat instead, which is the behaviour every older client gets.
            .apply {
                if (thread.isNotBlank()) {
                    put("thread", thread)
                    put("handoff", true)
                }
            }
            // C13 (impl §3, "单次推送（单 mid）"): the id of the row this phone wrote for the same
            // sentence. The target writes its own row under it, so whoever pushes first the relay
            // keeps one, and every device reads the sentence once.
            .apply { if (mid.isNotBlank()) put("mid", mid) }

        // The questions of this run in flight: the target's `approval_id` → the id the card
        // here carries. Per call, not per object: two runs at once (two chats, a second run
        // started from a chat already waiting) would otherwise take each other's cards down.
        // Concurrent because the answer comes off the hub's event thread and the card is
        // answered on the main one.
        val cards = ConcurrentHashMap<String, String>()

        val result = try {
            Hub.call(device.hubId, "task", body, TIMEOUT_MS) { event ->
                when (event.optString("stage")) {
                    "approval" -> {
                        // The question is answered off this thread, never waited on here: the
                        // event pump runs one handler at a time, so blocking it would hold back
                        // every frame behind this one — including the `approval_result` that
                        // says the target settled the question itself (upstream issue: the card
                        // then stayed up until the gate's own three-minute timeout).
                        val approvalId = event.optString("approval_id")
                        if (approvalId.isNotBlank()) {
                            val card = cardId(device, approvalId)
                            cards[approvalId] = card
                            scope.launch {
                                val allow = decideApproval(sessionId, device, card, event)
                                // no card came back: it was settled elsewhere (or this run ended)
                                // while the person was being asked, and an answer now would be
                                // about a question that is already gone
                                if (cards.remove(approvalId) == null) return@launch
                                // the answer goes to that Muse at once; it is waiting on it
                                runCatching {
                                    Hub.call(
                                        device.hubId,
                                        "approve",
                                        JSONObject().put("approval_id", approvalId).put("allow", allow),
                                        timeoutMs = 30_000L,
                                    )
                                }
                            }
                        }
                    }
                    "approval_result" -> {
                        // Decided at that device (or expired there): the card here comes down
                        // without an answer from this phone, the way a computer's own card does
                        // (`ComputerCards`). Nothing is sent back: a `Deny` from here would
                        // overrule a decision that device already made for itself.
                        val approvalId = event.optString("approval_id")
                        if (approvalId.isNotBlank()) {
                            cards.remove(approvalId)?.let { RiskGate.withdraw(it) }
                        }
                    }
                    "tool" -> {
                        val line = event.optString("summary").ifBlank { event.optString("name") }
                        if (line.isNotBlank()) onStep(Step.Running(line.take(200)))
                    }
                    "tool_result" -> {
                        val line = listOf(event.optString("name"), event.optString("summary"))
                            .filter { it.isNotBlank() }.joinToString(": ")
                        if (line.isNotBlank()) {
                            onStep(Step.Done(line.take(200), event.optBoolean("ok", true)))
                        }
                    }
                    "text" -> {
                        val said = event.optString("text")
                        if (said.isNotBlank() && !event.optBoolean("interim", false)) {
                            onStep(Step.Said(said.take(400)))
                        }
                    }
                    else -> Unit
                }
            }
        } catch (e: HubException) {
            return if (stopFlag()) Outcome.Stopped else Outcome.Failed(explain(device, e))
        } catch (e: Exception) {
            return if (stopFlag()) Outcome.Stopped
            else Outcome.Failed(e.message ?: "the device did not answer")
        } finally {
            _inFlight.update { runs ->
                val left = (runs[device.hubId] ?: 0) - 1
                if (left > 0) runs + (device.hubId to left) else runs - device.hubId
            }
            // The run is over: a card still up belongs to a step that will not run (the target
            // tears its own pending questions down with the run), so it comes down here too. A
            // waiter woken by this finds its entry gone and sends nothing.
            for (approvalId in cards.keys.toList()) {
                cards.remove(approvalId)?.let { RiskGate.withdraw(it) }
            }
        }

        if (stopFlag()) return Outcome.Stopped
        val answer = result.optString("text").trim().ifBlank { result.optString("answer").trim() }
        // An empty answer is not an answer (issue 718): steps having run does not make it one,
        // and showing it as done is how the phone came to say "finished" for work never done.
        return if (answer.isEmpty()) Outcome.Failed("${device.name} finished without an answer")
        else Outcome.Answered(answer)
    }

    /**
     * Ends a run started here: the target cancels it after the step in flight and answers
     * `{stopped: true}` (`docs/hub.md`). The `conversation` names it, which is the device id
     * this chat sends under, so a stop reaches the run this chat started and no other.
     */
    suspend fun stop(device: Computers.Computer, conversation: String) {
        withContext(Dispatchers.IO) {
            runCatching {
                Hub.call(
                    device.hubId,
                    "stop",
                    JSONObject().put("conversation", conversation),
                    timeoutMs = 15_000L,
                )
            }
        }
    }

    private fun explain(device: Computers.Computer, e: HubException): String = when (e.code) {
        "device_offline" -> "${device.name} is not connected right now"
        "timeout" -> "${device.name} did not answer in time"
        "not_allowed" -> "${device.name} is set not to be operated from other devices"
        else -> e.message ?: e.code
    }

    /**
     * One question that Muse asked, on this phone's card. The card is the app's usual one
     * ([RiskGate]), so a standing answer covers what it says it covers and nothing wider;
     * [RemoteApprovalKey] reads the `grant_key` the target sent, so two different steps
     * cannot share one remembered answer. [card] is the id the card carries here, so the
     * question can be taken back when the target settles it first.
     */
    private suspend fun decideApproval(
        sessionId: String,
        device: Computers.Computer,
        card: String,
        event: JSONObject,
    ): Boolean {
        val preview = event.optString("preview").ifBlank { event.optString("summary") }
        val assessment = RiskAssessment(
            riskClass(event.optString("risk")),
            event.optString("reason").ifBlank { "asked by ${device.name}" },
            RemoteApprovalKey.target(event),
        )
        val outcome = RiskGate.check(
            sessionId,
            GuardKind.COMPUTER,
            assessment,
            preview = "${device.name}: $preview",
            pageUrl = device.name,
            requestId = card,
        )
        return outcome is GateOutcome.Allowed
    }

    /** The same reading of a `risk` word the phone's other device path uses. */
    private fun riskClass(risk: String): RiskClass = when (risk.lowercase()) {
        "outbound", "send", "network" -> RiskClass.OUTBOUND
        "money", "payment" -> RiskClass.MONEY
        "install" -> RiskClass.INSTALL
        "safe" -> RiskClass.SAFE
        else -> RiskClass.DESTRUCTIVE // "system" and anything unnamed: ask, with the reason on the card
    }
}
