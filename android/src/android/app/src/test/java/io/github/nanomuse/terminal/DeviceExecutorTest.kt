package io.github.nanomuse.terminal

import io.github.nanomuse.reach.Computers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Which device runs a chat, as the line over the device strip reads it (contract C13,
 * `docs/session-handoff.md` §2 "界面必须常显当前 owner").
 *
 * The line and the send take the same resolution, so these check the rule the two share: an aim at
 * a device names it, online or not; a blank aim, an aim at this phone, and an aim at a device the
 * account has lost are all this phone. The line is hidden only when there is no other device for a
 * sentence to go to.
 */
class DeviceExecutorTest {
    private fun muse(hubId: String, name: String = "Mac mini", online: Boolean = true, kind: String = "computer", mine: Boolean = false) =
        Computers.Computer(id = "hub:$hubId", name = name, os = "macos", hubId = hubId, kind = kind, online = online, isThis = mine)

    private val phone = muse("phone-1", "Pixel 8", kind = "phone", mine = true)
    private val mac = muse("mac-1", "Mac mini")
    private val off = muse("off-1", "Old Laptop", online = false)
    private val muses = listOf(phone, mac, off)

    @Test
    fun a_blank_aim_runs_here() {
        assertEquals(DeviceExecutor.Target.Local, DeviceExecutor.of("", muses))
    }

    @Test
    fun an_aim_at_this_phone_runs_here() {
        assertEquals(DeviceExecutor.Target.Local, DeviceExecutor.of("phone-1", muses))
    }

    @Test
    fun an_aim_at_another_device_names_it() {
        val target = DeviceExecutor.of("mac-1", muses) as DeviceExecutor.Target.Device
        assertEquals("mac-1", target.id)
        assertEquals("Mac mini", target.name)
        assertTrue(target.online)
    }

    @Test
    fun an_aim_at_a_sleeping_device_keeps_it_and_says_it_is_offline() {
        // the case the person most needs to see before typing: the sentence would not go out
        val target = DeviceExecutor.of("off-1", muses) as DeviceExecutor.Target.Device
        assertEquals("off-1", target.id)
        assertFalse(target.online)
    }

    @Test
    fun an_aim_at_a_device_the_account_lost_runs_here() {
        // the same fallback the strip makes when an aim goes stale (DeviceStrip.focusIndex): there
        // is nothing to hand the sentence to
        assertEquals(DeviceExecutor.Target.Local, DeviceExecutor.of("gone-1", muses))
    }

    @Test
    fun the_aim_is_trimmed_before_it_is_matched() {
        val target = DeviceExecutor.of("  mac-1  ", muses) as DeviceExecutor.Target.Device
        assertEquals("mac-1", target.id)
    }

    @Test
    fun the_line_is_drawn_when_another_device_could_run_it() {
        assertTrue(DeviceExecutor.visible(DeviceExecutor.Target.Local, muses))
        assertTrue(DeviceExecutor.visible(DeviceExecutor.of("mac-1", muses), muses))
    }

    @Test
    fun the_line_is_hidden_on_an_account_with_no_other_device() {
        // "Run by this device" in every chat would say the same thing in all of them
        val only = listOf(phone)
        assertFalse(DeviceExecutor.visible(DeviceExecutor.Target.Local, only))
        // a device owner is always worth saying, even when it is the only other one
        assertTrue(DeviceExecutor.visible(DeviceExecutor.of("mac-1", listOf(phone, mac)), listOf(phone, mac)))
    }

    @Test
    fun a_browser_tab_never_counts_as_a_device_that_could_run_it() {
        val withTab = listOf(phone, muse("tab-1", "Chrome", kind = "web"))
        assertFalse(DeviceExecutor.visible(DeviceExecutor.Target.Local, withTab))
    }
}
