package io.github.nanomuse.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Which device runs the next turn of a chat, and what the composer's placeholder says
 * (executor handoff v2, `docs/tasks/executor-handoff-v2.md` §4.1/§4.2).
 */
class DeviceOwnerTest {
    private val self = "phone-main"
    private val selfLabel = "@本机"
    private val format: (String) -> String = { name -> "@$name" }

    @Test fun `no owner reported means this phone`() {
        assertEquals(DeviceOwner.Target.Local, DeviceOwner.target("", self))
        assertEquals(DeviceOwner.Target.Local, DeviceOwner.target("   ", self))
    }

    @Test fun `the owner this phone is this phone`() {
        assertEquals(DeviceOwner.Target.Local, DeviceOwner.target(self, self))
        // trimming holds here too: the relay's ids never carry padding, but a stored one might
        assertEquals(DeviceOwner.Target.Local, DeviceOwner.target(" $self ", self))
    }

    @Test fun `another device is the executor`() {
        val t = DeviceOwner.target("nas-1", self)
        assertEquals(DeviceOwner.Target.Remote(id = "nas-1", name = ""), t)
    }

    @Test fun `the relay's name for the owner is carried onto the target`() {
        val t = DeviceOwner.resolve("nas-1", "飞牛深圳", self)
        assertEquals(DeviceOwner.Target.Remote("nas-1", "飞牛深圳"), t)
    }

    @Test fun `a nameless remote falls back to its id`() {
        // the placeholder must still name something: the id is what `@…` addresses on the wire
        assertEquals(DeviceOwner.Target.Remote("nas-1", "nas-1"), DeviceOwner.resolve("nas-1", "  ", self))
        assertEquals(DeviceOwner.Target.Remote("nas-1", "nas-1"), DeviceOwner.resolve("nas-1", "", self))
    }

    @Test fun `a local target keeps its local wording, never a device name`() {
        // the owner field naming this phone is the ordinary case: it is drawn as 本机, and the
        // relay's name for this phone must not leak into that wording
        val t = DeviceOwner.resolve(self, "Pixel 8 Pro", self)
        assertEquals(DeviceOwner.Target.Local, t)
        assertEquals(selfLabel, DeviceOwner.placeholder(t, selfLabel, format))
    }

    @Test fun `the owner of a relay row and of a stored mapping are read the same way`() {
        val remote = RemoteConversation("c1", "main", "Main", "d0", "Pixel", 1, 2, false, 3, "nas-1", "飞牛深圳")
        assertEquals(DeviceOwner.Device("nas-1", "飞牛深圳"), DeviceOwner.of(remote))

        val stored = SyncConversation("main", "c1", "main", "d0", "Pixel", null, true, owner = "acct", ownerDevice = "nas-1", ownerDeviceName = "飞牛深圳")
        assertEquals(DeviceOwner.Device("nas-1", "飞牛深圳"), DeviceOwner.of(stored))

        // a row the relay never told us about has no owner at all
        assertNull(DeviceOwner.of(RemoteConversation("c1", "main", null, "d0", "", 1, 2, false, 3)))
        assertNull(DeviceOwner.of(SyncConversation("main", "c1", "main", "d0", "", null, true)))
    }

    @Test fun `the placeholder is this phone's own word when it runs here`() {
        assertEquals(selfLabel, DeviceOwner.placeholder(DeviceOwner.Target.Local, selfLabel, format))
    }

    @Test fun `the placeholder names the owner when another device runs it`() {
        val remote = DeviceOwner.resolve("nas-1", "飞牛深圳", self)
        assertEquals("@飞牛深圳", DeviceOwner.placeholder(remote, selfLabel, format))
    }

    @Test fun `the placeholder names a nameless owner by its id`() {
        val remote = DeviceOwner.resolve("nas-1", "", self)
        assertEquals("@nas-1", DeviceOwner.placeholder(remote, selfLabel, format))
    }

    @Test fun `the whole path from the relay's two fields to the placeholder`() {
        assertEquals(selfLabel, DeviceOwner.placeholder(DeviceOwner.resolve("", "", self), selfLabel, format))
        assertEquals(selfLabel, DeviceOwner.placeholder(DeviceOwner.resolve(self, "Pixel 8", self), selfLabel, format))
        assertEquals("@飞牛深圳", DeviceOwner.placeholder(DeviceOwner.resolve("nas-1", "飞牛深圳", self), selfLabel, format))
    }

    // ── a line that names this phone (the `@本机` switch, §4.2 rule 3) ──────

    @Test fun `the self word names this phone`() {
        assertTrue(DeviceOwner.addressesSelf("@本机 do it here", ""))
        assertTrue(DeviceOwner.addressesSelf("@本机", ""))
        assertTrue(DeviceOwner.addressesSelf("  @本机  ", ""))
        assertTrue(DeviceOwner.addressesSelf("@本机，做这个", ""))
    }

    @Test fun `English's placeholder names this phone too`() {
        // the composer shows `@This device` in the English locale (R.string.nm_executor_self);
        // typing what it shows must take the context back, or the placeholder lies
        assertTrue(DeviceOwner.addressesSelf("@This device do it here", ""))
        assertTrue(DeviceOwner.addressesSelf("@this device", ""))
        assertTrue(DeviceOwner.addressesSelf("@THIS DEVICE: go", ""))
        assertTrue(DeviceOwner.addressesSelf("@This device，做这个", ""))
        // its own name still works with no self word at all
        assertTrue(DeviceOwner.addressesSelf("@Pixel 8", "Pixel 8"))
    }

    @Test fun `a word that only starts like the self word is not a mention`() {
        // "@This devices" is some other device, not this phone (the word must end where it ends)
        assertFalse(DeviceOwner.addressesSelf("@This devices do it", ""))
        assertFalse(DeviceOwner.addressesSelf("@This deviceX", ""))
        assertFalse(DeviceOwner.addressesSelf("@This", ""))
    }

    @Test fun `this device's own name names this phone, case-insensitively`() {
        assertTrue(DeviceOwner.addressesSelf("@Pixel 8", "Pixel 8"))
        assertTrue(DeviceOwner.addressesSelf("@pixel 8", "Pixel 8"))
        assertTrue(DeviceOwner.addressesSelf("@Pixel 8: do it", "Pixel 8"))
        assertTrue(DeviceOwner.addressesSelf("@Pixel 8，做这个", "Pixel 8"))
    }

    @Test fun `a word that only starts like the name is not a mention`() {
        // "@本机子" is some other device, not this phone
        assertFalse(DeviceOwner.addressesSelf("@本机子 do it", ""))
        // this phone is "Pixel 8"; "@Pixel 8 Pro" is a *different* device of the account
        assertFalse(DeviceOwner.addressesSelf("@Pixel 8 Pro do it", "Pixel 8"))
        assertFalse(DeviceOwner.addressesSelf("@Pixel 8Pro do it", "Pixel 8"))
    }

    @Test fun `a space after the name is not taken as the boundary`() {
        // A deliberate trade-off: an account name can itself contain spaces ("Pixel 8 Pro"), so a
        // space cannot separate a name from the rest. "@Pixel 8 do it" therefore does not move the
        // owner — the safe reading, since the person can always write `@本机` or punctuate it off.
        assertFalse(DeviceOwner.addressesSelf("@Pixel 8 do it", "Pixel 8"))
    }

    @Test fun `an unknown or absent mention does not name this phone`() {
        assertFalse(DeviceOwner.addressesSelf("no mention here", "Pixel 8"))
        assertFalse(DeviceOwner.addressesSelf("@nobody do it", "Pixel 8"))
        assertFalse(DeviceOwner.addressesSelf("@ do it", "Pixel 8"))
        // a blank account name: only `@本机` can match
        assertFalse(DeviceOwner.addressesSelf("@anything", ""))
        assertTrue(DeviceOwner.addressesSelf("@本机", ""))
        // the mention must open the line
        assertFalse(DeviceOwner.addressesSelf("ask @本机 to do it", ""))
    }
}
