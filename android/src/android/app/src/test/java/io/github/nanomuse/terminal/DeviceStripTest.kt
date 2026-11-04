package io.github.nanomuse.terminal

import io.github.nanomuse.hub.Device
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The account's Muses as the header's row of faces: which are drawn, in what order, which one
 * is in the middle, and which the `@` picker offers.
 *
 * Two lists, and the difference between them is the point. [DeviceStrip.muses] is everyone,
 * this phone included, because the row shows the account rather than a list of things to write
 * to. [DeviceStrip.others] leaves the phone out, because it is the chat rather than something
 * the chat talks to, and nothing may be sent to it.
 */
class DeviceStripTest {
    private fun device(
        id: String,
        name: String,
        online: Boolean = true,
        kind: String = "computer",
        mine: Boolean = false,
    ) = Device(
        id = id,
        name = name,
        kind = kind,
        os = "macOS",
        version = "1.0.9",
        online = online,
        actions = emptyList(),
        lastSeen = 0L,
        isThis = mine,
    )

    private val phone = device("phone-1", "Pixel 8", kind = "phone", mine = true)
    private val devices = listOf(
        phone,
        device("mac-1", "Mac mini"),
        device("srv-1", "服务器"),
        device("off-1", "Old Laptop", online = false),
        device("tab-1", "Chrome", kind = "web"),
        device("blank-1", "   "),
    )

    // ── everyone, as the row draws them ──────────────────────────────────────────────

    @Test
    fun this_phone_is_one_of_the_muses() {
        assertTrue(DeviceStrip.muses(devices).any { it.hubId == "phone-1" })
    }

    @Test
    fun this_phone_comes_first() {
        assertEquals("phone-1", DeviceStrip.muses(devices).first().hubId)
    }

    @Test
    fun a_browser_tab_is_never_drawn() {
        assertTrue(DeviceStrip.muses(devices).none { it.hubId == "tab-1" })
    }

    @Test
    fun a_device_with_no_name_is_never_drawn() {
        assertTrue(DeviceStrip.muses(devices).none { it.hubId == "blank-1" })
    }

    @Test
    fun a_sleeping_device_is_still_drawn() {
        assertTrue(DeviceStrip.muses(devices).any { it.hubId == "off-1" })
    }

    @Test
    fun the_ones_that_are_up_come_before_the_sleeping_ones() {
        val ids = DeviceStrip.muses(devices).map { it.hubId }
        assertTrue(ids.indexOf("off-1") > ids.indexOf("mac-1"))
    }

    // ── what may be written to ───────────────────────────────────────────────────────

    @Test
    fun this_phone_is_never_something_to_write_to() {
        assertTrue(DeviceStrip.others(devices).none { it.hubId == "phone-1" })
    }

    @Test
    fun a_browser_tab_is_never_something_to_write_to() {
        assertTrue(DeviceStrip.others(devices).none { it.hubId == "tab-1" })
    }

    @Test
    fun a_sleeping_device_is_offered_and_says_so_later() {
        // offered, not hidden: the picker says "offline" on the row, and a tap says it in words
        assertTrue(DeviceStrip.others(devices).any { it.hubId == "off-1" })
    }

    // ── the middle face and the two sides ────────────────────────────────────────────

    @Test
    fun the_open_chats_device_is_the_middle_face() {
        val row = DeviceStrip.sides(devices, focusedHubId = "srv-1", phoneId = "phone-1")
        assertEquals("srv-1", row.middle?.hubId)
    }

    @Test
    fun no_device_means_this_phones_own_chat_is_the_middle_face() {
        val row = DeviceStrip.sides(devices, focusedHubId = "", phoneId = "phone-1")
        assertEquals("phone-1", row.middle?.hubId)
    }

    @Test
    fun the_middle_face_is_on_neither_side() {
        val row = DeviceStrip.sides(devices, focusedHubId = "srv-1", phoneId = "phone-1")
        val sides = row.left + row.right
        assertTrue(sides.none { it.hubId == "srv-1" })
    }

    @Test
    fun every_muse_is_drawn_once_across_the_row() {
        val row = DeviceStrip.sides(devices, focusedHubId = "srv-1", phoneId = "phone-1")
        val drawn = (row.left + row.right + listOfNotNull(row.middle)).map { it.hubId }
        assertEquals(drawn.size, drawn.toSet().size)
        assertEquals(DeviceStrip.muses(devices).size, drawn.size)
    }

    @Test
    fun the_two_sides_differ_by_at_most_one() {
        val row = DeviceStrip.sides(devices, focusedHubId = "srv-1", phoneId = "phone-1")
        assertTrue(kotlin.math.abs(row.left.size - row.right.size) <= 1)
    }

    @Test
    fun an_aim_at_a_device_the_account_lost_falls_back_to_this_phone() {
        val row = DeviceStrip.sides(devices, focusedHubId = "gone-1", phoneId = "phone-1")
        assertEquals("phone-1", row.middle?.hubId)
    }

    @Test
    fun no_devices_at_all_means_no_middle_face() {
        val row = DeviceStrip.sides(emptyList(), focusedHubId = "", phoneId = "phone-1")
        assertNull(row.middle)
        assertEquals(0, row.left.size + row.right.size)
    }

    // ── the picker ───────────────────────────────────────────────────────────────────

    @Test
    fun an_empty_prefix_offers_every_device() {
        assertEquals(3, DeviceStrip.suggestions(DeviceStrip.others(devices), "").size)
    }

    @Test
    fun a_name_that_starts_with_the_typing_comes_before_one_that_merely_contains_it() {
        val all = DeviceStrip.muses(listOf(device("a", "My Mac mini"), device("b", "Mac mini")))
        assertEquals("b", DeviceStrip.suggestions(all, "mac").first().hubId)
    }

    @Test
    fun the_prefix_is_matched_without_case() {
        assertEquals(1, DeviceStrip.suggestions(DeviceStrip.others(devices), "mac").size)
    }

    @Test
    fun the_picker_is_capped() {
        val many = DeviceStrip.muses((1..20).map { device("d-$it", "Device $it") })
        assertEquals(6, DeviceStrip.suggestions(many, "").size)
    }

    // ── what was typed after the @ ──────────────────────────────────────────────────

    @Test
    fun what_follows_a_leading_at_is_the_filter() {
        assertEquals("mac", DeviceStrip.afterAt("@mac"))
        assertEquals("", DeviceStrip.afterAt("@"))
    }

    @Test
    fun a_space_does_not_end_the_filter() {
        // the picker upstream reads everything from the @ to the caret, spaces included, so a
        // device called "Mac mini" is still found while its second word is being typed
        assertEquals("mac tidy the downloads", DeviceStrip.afterAt("@mac tidy the downloads"))
        assertEquals("Mac mini", DeviceStrip.afterAt("@Mac mini"))
    }

    @Test
    fun an_at_that_does_not_open_the_message_is_not_a_mention() {
        assertNull(DeviceStrip.afterAt("look at mac"))
        assertNull(DeviceStrip.afterAt("foo@bar.com"))
    }

    // ── which device is this one ─────────────────────────────────────────────────────

    @Test
    fun the_relays_this_marks_survive_as_the_row_is_built() {
        // The face of the device being held says "This device" rather than the account's name for
        // it, which is the same on every device — so the flag has to reach the view, and the
        // mapping from the relay's Device to a Computer is where it could be dropped.
        val mine = DeviceStrip.muses(devices).single { it.hubId == "phone-1" }
        assertTrue(mine.isThis)
    }

    @Test
    fun the_other_muses_are_not_marked_as_this_one() {
        val others = DeviceStrip.muses(devices).filter { it.hubId != "phone-1" }
        assertTrue(others.none { it.isThis })
    }
}