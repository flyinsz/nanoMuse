package io.github.nanomuse.terminal

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Whether a device's face should wear the "something to read" dot.
 *
 * A device's chat is where a reply lands while nobody is watching it, so the strip is the only
 * place that can say so. The rule has to hold in both directions: it must mark a chat the person
 * has never opened and one that moved on since they last read it, and it must not mark the chat
 * they are reading right now — a dot on the thing in front of them says nothing.
 */
class DeviceNewsTest {
    private val ten = 1_700_000_000_000L

    @Test
    fun a_chat_never_read_has_news() {
        assertTrue(DeviceNews.unread(updatedAt = ten, seenAt = 0L))
    }

    @Test
    fun a_chat_that_moved_on_since_it_was_read_has_news() {
        assertTrue(DeviceNews.unread(updatedAt = ten, seenAt = ten - 60_000))
    }

    @Test
    fun a_chat_read_to_its_latest_message_has_no_news() {
        assertFalse(DeviceNews.unread(updatedAt = ten, seenAt = ten))
    }

    @Test
    fun a_chat_whose_mark_is_ahead_of_it_has_no_news() {
        // the ordinary case for the chat being looked at: it was marked seen when it opened, and
        // nothing has been written since
        assertFalse(DeviceNews.unread(updatedAt = ten - 60_000, seenAt = ten))
    }

    @Test
    fun a_chat_with_no_write_time_never_has_news() {
        assertFalse(DeviceNews.unread(updatedAt = 0L, seenAt = 0L))
    }
}
