package io.github.nanomuse.terminal

import android.content.Context
import io.github.nanomuse.hub.Device
import io.github.nanomuse.reach.Computers

/**
 * Which device a chat is aimed at: the avatar the person tapped in the strip above the box.
 *
 * Why this is not a column on the chat. Android's chats live in OpenMinis' own `sessions` table
 * (`minis.db`), which has no device column, and adding one means a Room migration, a schema
 * export and a rule about whether the binding syncs to the account's other devices (the table
 * already carries `source` for where a chat came from; a second device column of the opposite
 * meaning, "where what I type is going", would be read wrong sooner or later). A chat's target
 * is also not a fact about the chat the way its title is: it is the person's current intent, it
 * changes as they change their mind, and losing it on a reinstall costs one tap. So it is kept
 * where the app already keeps this kind of small live thing, next to the hub's own conversation
 * mapping (`HubActions.sessionFor`).
 *
 * What it buys: with a device aimed at, a message typed into that chat goes to the device even
 * when it does not open with `@<device>` — which is what tapping an avatar has to mean for the
 * tap to be worth making. A message that names a device still goes to that one.
 *
 * An aim at a device that is asleep survives until it wakes: the send says "not connected right
 * now" rather than quietly doing the work here instead, which is why the aim is resolved
 * against the hub's whole list and not just what is reachable this second.
 *
 * Stored per chat are the hub's plain device ids (`Computers.Computer.hubId`), which is what
 * [DeviceTargetMention.parse] also resolves to, so an aim and a mention can be compared.
 */
object DeviceAim {
    private const val PREFS = "nm_device_aim"

    /** The hub id of the device this chat is aimed at, or null when it goes to this phone's Muse. */
    fun id(context: Context, sessionId: String): String? {
        if (sessionId.isBlank()) return null
        return prefs(context).getString(sessionId, null)?.takeIf { it.isNotBlank() }
    }

    /**
     * Aim this chat at [hubId], or clear it with null. Returns what the chat is aimed at
     * afterwards, which is what the strip draws.
     */
    fun set(context: Context, sessionId: String, hubId: String?): String? {
        if (sessionId.isBlank()) return null
        val edit = prefs(context).edit()
        if (hubId.isNullOrBlank()) edit.remove(sessionId) else edit.putString(sessionId, hubId)
        edit.apply()
        return hubId?.takeIf { it.isNotBlank() }
    }

    /**
     * The device to send a message to, or null for the ordinary path: the one the message names
     * itself (`@<device>`), else the one the chat is aimed at, else none. A message that names
     * a device this phone cannot reach is not silently swapped for the aimed one: the person
     * asked for that device in as many words, so the mention path says what happened to it.
     */
    fun target(context: Context, sessionId: String, text: String, known: List<Computers.Computer>): Computers.Computer? {
        val named =
            if (text.trimStart().startsWith("@")) DeviceTargetMention.parse(context, text)?.device else null
        return pick(text, aimedId = id(context, sessionId), known = known, named = named)
    }

    /**
     * The rule, on ids alone, so it can be read (and checked) without a device or a context:
     * what [target] decides. [named] is the device the message itself addresses, when it
     * addresses one this phone can reach; null covers both "no mention" and "a mention of
     * nobody", which lead the same way, to the chat's own aim.
     */
    internal fun pick(
        text: String,
        aimedId: String?,
        known: List<Computers.Computer>,
        named: Computers.Computer? = null,
    ): Computers.Computer? {
        val aimed = aimedId?.takeIf { it.isNotBlank() }?.let { hubId -> known.firstOrNull { it.hubId == hubId } }
        if (!text.trimStart().startsWith("@")) return aimed
        return named ?: aimed
    }

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
