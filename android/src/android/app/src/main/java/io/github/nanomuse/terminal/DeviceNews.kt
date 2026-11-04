package io.github.nanomuse.terminal

import android.content.Context

/**
 * When each device chat was last read on this phone, so the strip can mark one that has news.
 *
 * Why this is kept at all. A device's chat is a place replies arrive while nobody is looking at
 * it — that is the whole reason to hand work to a device and walk away — so the strip is the only
 * place that can say "there is something to read in there". Without it the only way to learn that
 * a device has answered is to open each one in turn, which is exactly the cost the strip exists
 * to remove.
 *
 * Kept next to the other small live facts about a chat ([DeviceAim] for where a message goes,
 * [DeviceChat] for which chat a device has) and for the same reason: none of them is a column on
 * the chat. Whether a chat has news is about what was read *here*, not about the account, so it
 * does not sync and it does not belong in the database.
 *
 * The moments are the chat row's own `updatedAt`, in milliseconds, which is the timestamp the
 * session list already orders and badges by — so a device's face and its row in the drawer agree
 * about what "new" means.
 */
object DeviceNews {
    private const val PREFS = "nm_device_news"

    /** The last-write time of [sessionId] at the moment it was last read here, or 0. */
    fun seenAt(context: Context, sessionId: String): Long {
        if (sessionId.isBlank()) return 0L
        return prefs(context).getLong(sessionId, 0L)
    }

    /** Record that [sessionId] has been read up to [updatedAt], the chat's own last-write time. */
    fun markSeen(context: Context, sessionId: String, updatedAt: Long) {
        if (sessionId.isBlank() || updatedAt <= 0L) return
        // never move the mark backwards: two replies can be committed out of order, and an older
        // one landing last must not un-read the newer
        if (updatedAt <= seenAt(context, sessionId)) return
        prefs(context).edit().putLong(sessionId, updatedAt).apply()
    }

    /**
     * Whether a chat last written at [updatedAt] holds something unread, given it was last read
     * here at [seenAt]. The rule on its own, so it can be checked without a context; 0 means
     * "never read", which is the case that must be marked.
     */
    fun unread(updatedAt: Long, seenAt: Long): Boolean = updatedAt > seenAt

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
