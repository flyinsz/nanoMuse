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

    /**
     * The runtime's own name for a device's main conversation (`nanomuse/server/events.py`'s
     * `MAIN_THREAD`). It is what a `task` names to run on that device's main chat — the
     * conversation whose full context is the one a chat with its Muse is meant to continue
     * (contract C13, impl §D). Every device calls its own main conversation by this id.
     */
    const val MAIN_THREAD = "main"

    /** The conversation this phone keeps with [hubId], named the way the relay names it. */
    fun conversationOf(hubId: String): String = "to-" + hubId

    /** The chat already made for [device], or null when there is none or it is gone. */
    suspend fun existing(context: Context, repo: ChatRepository, device: Computers.Computer): String? {
        val id = prefs(context).getString(key(device), null)?.takeIf { it.isNotBlank() } ?: return null
        return id.takeIf { runCatching { repo.dao.getSession(it) }.getOrNull() != null }
    }

    /**
     * The hub id of the device [sessionId] is the chat of, or null when it is not a device's
     * chat: the mapping read backwards. A chat and its device cannot disagree about each other
     * ([remember] writes both), so this is the same fact the aim holds and the header draws.
     */
    fun deviceOf(context: Context, sessionId: String): String? {
        if (sessionId.isBlank()) return null
        val prefix = "hub.session.to-"
        return prefs(context).all.entries
            .firstOrNull { (k, v) -> k.startsWith(prefix) && v == sessionId }
            ?.key
            ?.removePrefix(prefix)
            ?.takeIf { it.isNotBlank() }
    }

    /**
     * The chat already made for the device named by [hubId], or null when there is none or it is
     * gone. The read-only half of [existing], for the paths that must not make one: a turn
     * arriving through sync looks here to know whether the device it came from has a chat on this
     * phone to be shown in as well, and a chat the person never opened is not one to invent.
     */
    suspend fun existingFor(context: Context, repo: ChatRepository, hubId: String): String? {
        val id = prefs(context).getString("hub.session.${conversationOf(hubId)}", null)
            ?.takeIf { it.isNotBlank() } ?: return null
        return id.takeIf { runCatching { repo.dao.getSession(it) }.getOrNull() != null }
    }

    /**
     * The chat this phone keeps with [device], making it when there is none: what tapping a
     * device's face opens, and where a message addressed to that device goes.
     *
     * [seedModel] is what a chat that has to be made is created on — the model the person is
     * talking to right now. Null when there is no model to seed with, in which case a chat that
     * does not exist yet cannot be made either.
     *
     * The two halves live together because both callers need the same order: reuse what exists,
     * else make one and remember it. Splitting them is how a tap and a send could end up with a
     * chat each. An existing chat is re-aimed here as well: a chat of a device is *aimed* at it
     * (the invariant [remember] writes), so a chat whose aim went missing is put back in step
     * rather than sending the next message to the wrong place.
     */
    suspend fun ensure(
        context: Context,
        repo: ChatRepository,
        device: Computers.Computer,
        seedModel: String?,
        memoryEnabled: Boolean,
    ): String? {
        existing(context, repo, device)?.let { id ->
            DeviceAim.set(context, id, device.hubId)
            return id
        }
        if (seedModel.isNullOrBlank()) return null
        val title = context.getString(com.openminis.app.R.string.nm_device_chat_title, device.name)
        val made = runCatching {
            repo.createSession(modelId = seedModel, title = title, memoryEnabled = memoryEnabled)
        }.getOrNull() ?: return null
        remember(context, device, made.id)
        return made.id
    }

    /**
     * Records the chat made for [device], so the next tap returns to it rather than making
     * another. Aimed at the same moment: the chat exists in order to talk to that device, so
     * the two facts are written together and cannot drift.
     *
     * Nothing is written for this phone. A chat *with* the phone is not a thing: the phone's own
     * Muse is the main chat, and picking its face goes back there rather than opening one. A
     * mapping recorded for it would name a chat with no way to be opened, so its dot could never
     * be cleared — which is what a leftover from before the relay's `this` was read did.
     */
    fun remember(context: Context, device: Computers.Computer, sessionId: String) {
        if (device.isThis) return
        prefs(context).edit().putString(key(device), sessionId).apply()
        DeviceAim.set(context, sessionId, device.hubId)
    }

    private fun key(device: Computers.Computer) = "hub.session.${conversationOf(device.hubId)}"

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
