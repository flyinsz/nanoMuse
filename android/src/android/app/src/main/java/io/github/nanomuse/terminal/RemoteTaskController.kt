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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.json.JSONObject

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

    /** One line of what the run is doing, drawn under the person's message. */
    sealed interface Step {
        data class Running(val text: String) : Step
        data class Done(val text: String, val ok: Boolean) : Step
        data class Said(val text: String) : Step
    }

    /**
     * What became of the run. [Answered.text] is the target's own words and the only thing
     * that counts as an answer; an empty one is [Failed], never a quiet success (issue 718).
     */
    sealed interface Outcome {
        data class Answered(val text: String) : Outcome
        data class Failed(val reason: String) : Outcome
        data object Stopped : Outcome
    }

    /** Whether this phone may run things on another device at all. */
    fun available(context: Context): Boolean = Hub.isConnected && Hub.others(context).isNotEmpty()

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
    ): Outcome {
        val body = JSONObject()
            .put("text", text)
            .put("conversation", conversation)
            .put("from", Hub.name(context))
            .put("stream", true)
            .apply { if (language.isNotBlank()) put("language", language) }

        val result = try {
            Hub.call(device.hubId, "task", body, TIMEOUT_MS) { event ->
                when (event.optString("stage")) {
                    "approval" -> {
                        val id = event.optString("approval_id")
                        if (id.isNotBlank()) {
                            val allow = runBlocking { decideApproval(sessionId, device, event) }
                            // the answer goes to that Muse at once; it is waiting on it
                            runCatching {
                                Hub.call(
                                    device.hubId,
                                    "approve",
                                    JSONObject().put("approval_id", id).put("allow", allow),
                                    timeoutMs = 30_000L,
                                )
                            }
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
     * cannot share one remembered answer.
     */
    private suspend fun decideApproval(
        sessionId: String,
        device: Computers.Computer,
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
