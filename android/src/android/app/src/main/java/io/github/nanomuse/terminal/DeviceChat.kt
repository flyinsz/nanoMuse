package io.github.nanomuse.terminal

import android.content.Context
import com.openminis.app.data.repository.ChatRepository
import io.github.nanomuse.reach.Computers

/**
 * The chat a device has on this phone, made the first time it is asked for and returned to
 * after that: what tapping a device's face in the header opens.
 *
 * Why a chat per device. The runtime keeps one per device and hands the same one back
 * (`ask_device`), the console lands in it, and iOS does the same; a chat is where a device's
 * answers, its steps and the questions it asks about them all belong. Sending one device's
 * answer into whatever chat happened to be open instead — which is what the phone did at first
 * — reads as the phone's own Muse having done the work, and leaves the next question nowhere
 * to go.
 *
 * A chat of a device is also *aimed* at it: the same fact, read the other way. It is what the
 * header draws large and what a send reads to know where an unnamed message goes, so a chat and
 * its device cannot disagree about each other ([DeviceAim] holds it, and holds it once).
 *
 * It is a preference and not a column on the chat: see [DeviceAim] for why the phone does not
 * put a device on a chat's row. It lives in the same store the inbound direction uses
 * (`HubActions.sessionFor`, `hub.session.<conversation>`), under this phone's own key, so a
 * device that wrote here first and one written to first each end up with one chat.
 */
object DeviceChat {
    private const val PREFS = "nanomuse"

    /** The conversation this phone keeps with [hubId], named the way the relay names it. */
    fun conversationOf(hubId: String): String = "to-" + hubId

    /** The chat already made for [device], or null when there is none or it is gone. */
    suspend fun existing(context: Context, repo: ChatRepository, device: Computers.Computer): String? {
        val id = prefs(context).getString(key(device), null)?.takeIf { it.isNotBlank() } ?: return null
        return id.takeIf { runCatching { repo.dao.getSession(it) }.getOrNull() != null }
    }

    /**
     * Records the chat made for [device], so the next tap returns to it rather than making
     * another. Aimed at the same moment: the chat exists in order to talk to that device, so
     * the two facts are written together and cannot drift.
     */
    fun remember(context: Context, device: Computers.Computer, sessionId: String) {
        prefs(context).edit().putString(key(device), sessionId).apply()
        DeviceAim.set(context, sessionId, device.hubId)
    }

    private fun key(device: Computers.Computer) = "hub.session.${conversationOf(device.hubId)}"

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
