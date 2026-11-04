package io.github.nanomuse.terminal

import io.github.nanomuse.reach.Computers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Which device a message goes to, once a chat can be aimed at one by tapping its avatar.
 *
 * The rule answers two questions that look alike and are not. A message that names a device
 * addresses it, whatever the chat is aimed at; a message that names nobody goes to the chat's
 * aim, which is the whole point of tapping an avatar (otherwise the tap would only save typing
 * `@<name>` and do nothing else). And a chat with no aim is what every chat was before this:
 * the message goes to this phone's own Muse.
 */
class DeviceAimTest {
    private fun computer(hubId: String, name: String, online: Boolean = true) =
        Computers.Computer(id = "hub:$hubId", name = name, os = "macOS", hubId = hubId, online = online)

    private val mac = computer("mac-1", "Mac mini")
    private val srv = computer("srv-1", "服务器")
    private val asleep = computer("off-1", "Old Laptop", online = false)
    private val known = listOf(mac, srv, asleep)

    // ── a chat with no aim goes where it always did ────────────────────────────────────

    @Test
    fun a_plain_message_in_an_unaimed_chat_goes_nowhere_special() {
        assertNull(DeviceAim.pick("tidy the downloads", aimedId = null, known = known))
    }

    @Test
    fun an_aim_of_a_device_this_phone_no_longer_knows_is_no_aim() {
        assertNull(DeviceAim.pick("tidy the downloads", aimedId = "gone-1", known = known))
    }

    @Test
    fun a_blank_aim_is_no_aim() {
        assertNull(DeviceAim.pick("tidy", aimedId = "  ", known = known))
    }

    // ── the aim carries an unmentioned message ────────────────────────────────────────

    @Test
    fun an_aimed_chat_sends_an_unmentioned_message_to_that_device() {
        assertEquals(mac, DeviceAim.pick("tidy the downloads", aimedId = "mac-1", known = known))
    }

    @Test
    fun an_aim_at_a_sleeping_device_still_resolves_so_the_send_can_say_so() {
        // the aim outlives the nap: the send answers "not connected right now" rather than
        // quietly doing the work here
        assertEquals(asleep, DeviceAim.pick("tidy", aimedId = "off-1", known = known))
    }

    // ── a mention wins over the aim ───────────────────────────────────────────────────

    @Test
    fun a_message_that_names_a_device_goes_there_not_to_the_chats_aim() {
        assertEquals(srv, DeviceAim.pick("@服务器 tidy", aimedId = "mac-1", known = known, named = srv))
    }

    @Test
    fun a_mention_in_an_unaimed_chat_still_resolves() {
        assertEquals(srv, DeviceAim.pick("@服务器 tidy", aimedId = null, known = known, named = srv))
    }

    @Test
    fun a_mention_of_nobody_falls_back_to_the_chats_aim() {
        // "@nobody" is not a device of the account, so `named` is null: the mention reads as
        // ordinary text and the chat's own aim still decides, rather than the message going
        // nowhere at all
        assertEquals(mac, DeviceAim.pick("@nobody tidy", aimedId = "mac-1", known = known, named = null))
    }

    @Test
    fun a_lone_at_is_not_a_mention_and_uses_the_aim() {
        assertEquals(mac, DeviceAim.pick("@", aimedId = "mac-1", known = known, named = null))
    }

    @Test
    fun a_name_without_a_leading_at_is_not_a_mention_and_uses_the_aim() {
        assertEquals(mac, DeviceAim.pick("ask Mac mini about it", aimedId = "mac-1", known = known, named = null))
    }

    @Test
    fun an_at_that_does_not_open_the_message_uses_the_aim() {
        assertEquals(mac, DeviceAim.pick("look at mac", aimedId = "mac-1", known = known, named = null))
    }
}
