package io.github.nanomuse.terminal

import io.github.nanomuse.hub.Device
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Which devices the strip draws, in what order, and which the `@` picker offers. The picker's
 * half follows iOS (`NanoMuseDeviceMention.menuEntries`): the account's own devices, online
 * first, the ones whose name begins with what was typed above the ones that merely contain it,
 * and picking one writes `@<name> ` for [DeviceTargetMention.reading] to read back at send.
 * The strip keeps the offline ones so a sleeping device is still visible.
 */
class DeviceStripTest {
    private fun device(id: String, name: String, online: Boolean = true, kind: String = "computer") =
        Device(id = id, name = name, kind = kind, os = "macOS", version = "1.0.9", online = online, actions = emptyList(), lastSeen = 0L)

    private val devices = listOf(
        device("mac-1", "Mac mini"),
        device("srv-1", "服务器"),
        device("ph-1", "Pixel 8", kind = "phone"),
        device("off-1", "Old Laptop", online = false),
        device("tab-1", "Chrome", kind = "web"),
        device("blank-1", "   "),
    )

    // ── the set ───────────────────────────────────────────────────────────────────────

    @Test
    fun a_browser_tab_is_never_offered() {
        val ids = DeviceStrip.devices(devices).map { it.id }
        assertEquals(false, ids.contains("tab-1"))
    }

    @Test
    fun a_device_with_no_name_is_never_offered() {
        val ids = DeviceStrip.devices(devices).map { it.id }
        assertEquals(false, ids.contains("blank-1"))
    }

    @Test
    fun an_offline_device_is_still_listed() {
        val ids = DeviceStrip.devices(devices).map { it.id }
        assertEquals(true, ids.contains("off-1"))
    }

    // ── the strip ─────────────────────────────────────────────────────────────────────

    @Test
    fun the_open_chats_device_is_first() {
        val chips = DeviceStrip.strip(DeviceStrip.devices(devices), chatDevice = "ph-1")
        assertEquals("ph-1", chips.first().device.id)
        assertEquals(true, chips.first().focused)
    }

    @Test
    fun only_the_open_chats_device_is_focused() {
        val chips = DeviceStrip.strip(DeviceStrip.devices(devices), chatDevice = "mac-1")
        assertEquals(listOf("mac-1"), chips.filter { it.focused }.map { it.device.id })
    }

    @Test
    fun nothing_is_focused_when_the_chat_goes_nowhere() {
        val chips = DeviceStrip.strip(DeviceStrip.devices(devices), chatDevice = "")
        assertEquals(0, chips.count { it.focused })
    }

    @Test
    fun the_online_ones_come_before_the_offline_ones() {
        val ids = DeviceStrip.strip(DeviceStrip.devices(devices), chatDevice = "").map { it.device.id }
        assertEquals(true, ids.indexOf("off-1") > ids.indexOf("mac-1"))
    }

    // ── the picker ────────────────────────────────────────────────────────────────────

    @Test
    fun an_empty_prefix_offers_every_device() {
        assertEquals(4, DeviceStrip.suggestions(DeviceStrip.devices(devices), "").size)
    }

    @Test
    fun the_online_ones_come_first_in_the_picker() {
        val ids = DeviceStrip.suggestions(DeviceStrip.devices(devices), "").map { it.id }
        assertEquals("off-1", ids.last())
    }

    @Test
    fun a_name_that_starts_with_the_typing_comes_before_one_that_merely_contains_it() {
        val all = listOf(device("a", "My Mac mini"), device("b", "Mac mini"))
        assertEquals("b", DeviceStrip.suggestions(all, "mac").first().id)
    }

    @Test
    fun the_prefix_is_matched_without_case() {
        assertEquals(1, DeviceStrip.suggestions(DeviceStrip.devices(devices), "mac").size)
    }

    @Test
    fun the_picker_is_capped() {
        val many = (1..20).map { device("d-$it", "Device $it") }
        assertEquals(6, DeviceStrip.suggestions(many, "").size)
    }

    // ── what was typed after the @ ────────────────────────────────────────────────────

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
}
