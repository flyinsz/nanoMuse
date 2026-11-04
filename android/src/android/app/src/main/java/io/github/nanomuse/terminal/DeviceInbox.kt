package io.github.nanomuse.terminal

import android.content.Context

/**
 * What arrived on this phone from the account's other devices, and which of it has not been read.
 *
 * A task another device hands this phone runs in a chat of its own — `From <device>` for the ones
 * this phone's Muse answers (`HubActions.sessionFor`), or whatever conversation the sender named.
 * Nothing ties those chats to a face of the strip: the faces are the *devices*, and a chat that
 * arrived from one is not a chat with one. The phone's own face is therefore the only place that
 * can say "another device sent you something", and the only thing a tap on it can open.
 *
 * The two halves are here together because they answer one question — what does the phone's face
 * point at — and the tap and the dot must not disagree: a face wearing a dot has to open the thing
 * the dot is about, and the face that has none has to go back to being the main chat.
 *
 * Which chats these are: the keys the inbound direction writes are every `hub.session.` key but
 * the ones [DeviceChat] writes for a chat addressed *to* a device (`to-<hubId>`). The distinction
 * is in the key itself, so it holds whatever the sender named its conversation — a `from-<id>` a
 * plain delegate makes, or a runtime thread id.
 */
object DeviceInbox {
    private const val PREFS = "nanomuse"
    private const val PREFIX = "hub.session."
    private const val OUT = PREFIX + "to-"

    /** The chats on this phone that arrived from another device, as session ids. */
    fun incoming(context: Context): List<String> {
        val store = prefs(context)
        return store.all.keys
            .filter { it.startsWith(PREFIX) && !it.startsWith(OUT) }
            .mapNotNull { (store.getString(it, null))?.takeIf(String::isNotBlank) }
    }

    /**
     * The chat the phone's own face opens: the most recently written of [candidates] that still
     * holds something unread, or null when none does — the caller then goes to the main chat,
     * which is what a face with no dot means.
     *
     * [candidates] is `id to lastWrite` and [seenAt] is when that chat was last read here, so this
     * weighs exactly what [DeviceNews] weighs and cannot drift from the dot it answers for.
     * "Most recently written" rather than "oldest": the newest arrival is the one a person opening
     * their phone is looking for, and reading it leaves the older ones for the next tap.
     */
    fun newestUnread(
        candidates: List<Pair<String, Long>>,
        seenAt: (String) -> Long,
    ): String? = candidates
        .filter { (id, at) -> DeviceNews.unread(updatedAt = at, seenAt = seenAt(id)) }
        .maxByOrNull { (_, at) -> at }
        ?.first

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
