package io.github.nanomuse.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * What the phone's own face opens, and why it is not always the main chat.
 *
 * The face wears a dot when another device's task landed here unread, and a face wearing a dot has
 * to open the thing the dot is about — otherwise the mark points at a chat nobody can reach from
 * it. With no dot it goes back to the main chat, which is what the face means the rest of the time
 * (this phone's own Muse is the main chat, and there is no chat *with* the phone to open).
 */
class DeviceInboxTest {
    private val ten = 1_700_000_000_000L
    private val none: (String) -> Long = { 0L }

    @Test
    fun the_only_unread_chat_is_the_one_opened() {
        assertEquals("a", DeviceInbox.newestUnread(listOf("a" to ten), none))
    }

    @Test
    fun the_newest_of_several_unread_ones_is_chosen() {
        val candidates = listOf("old" to ten - 300_000, "new" to ten, "mid" to ten - 60_000)
        assertEquals("new", DeviceInbox.newestUnread(candidates, none))
    }

    @Test
    fun a_chat_read_to_its_latest_is_not_chosen() {
        val seen = mapOf("a" to ten, "b" to 0L)
        assertEquals("b", DeviceInbox.newestUnread(listOf("a" to ten, "b" to ten - 1), { seen[it] ?: 0L }))
    }

    @Test
    fun nothing_unread_means_the_main_chat() {
        assertNull(DeviceInbox.newestUnread(listOf("a" to ten), { ten }))
    }

    @Test
    fun no_incoming_chats_at_all_means_the_main_chat() {
        assertNull(DeviceInbox.newestUnread(emptyList(), none))
    }

    @Test
    fun a_newer_read_chat_does_not_displace_an_older_unread_one() {
        // reading the newest of two leaves the older one still to read, and the next tap must
        // open that one rather than fall back to the main chat
        val seen = mapOf("new" to ten)
        assertEquals("old", DeviceInbox.newestUnread(listOf("old" to ten - 60_000, "new" to ten), { seen[it] ?: 0L }))
    }
}
