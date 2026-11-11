package io.github.nanomuse.sync

import com.openminis.app.ui.chat.AssistantBlock
import io.github.nanomuse.hub.Device
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The one behaviour change from upstream (executor handoff v2, §4.2): a line typed with no `@`
 * goes to the chat's owner instead of always running on this phone.
 *
 * `send` is `suspend` since the owner is re-read from the database before routing (§4.2), so
 * every test drives it from `runTest`. The route itself is still decided before any job is
 * launched — the task is built synchronously — so the assertions read what `send` already
 * decided, and the bridge's own unconfined scope runs the launched body inline.
 */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class OwnerRoutingTest {
    private val desk = Device("desk", "Desk", "computer", "Linux", "", true, listOf("task"), 0)

    private class Host(
        private val owner: String?,
        private val name: String? = null,
        private val namesSelf: Boolean = true,
    ) : RemoteChatBridge.Host {
        var running = false
        var draft = ""
        var lastIssue: RemoteChatBridge.Issue? = null
        var lastIssueDevice: String = ""
        var tookHere: String? = null
        override val busy: Boolean get() = running
        override fun setBusy(value: Boolean) { running = value }
        override fun error(issue: RemoteChatBridge.Issue, device: String) { lastIssue = issue; lastIssueDevice = device }
        override fun clearDraft() { draft = "" }
        override fun restoreDraft(text: String) { draft = text }
        override suspend fun session() = "session"
        override suspend fun user(sessionId: String, text: String): String = "mid-1"
        override fun show(id: String, task: RemoteChatBridge.Task) {}
        override suspend fun finish(sessionId: String, id: String, task: RemoteChatBridge.Task) {}
        override fun afterTurn() {}
        override fun ownerId(): String? = owner
        override fun ownerName(): String? = name
        override fun takeOwnerHere(text: String) { tookHere = text }
        override fun namesSelf(text: String): Boolean = namesSelf
    }

    private class Task : RemoteChatBridge.Task {
        override val text = "remote answer"
        override val blocks = emptyList<AssistantBlock>()
        override val failed = false
        var gotMid: String? = null
        override suspend fun run(sessionId: String, mid: String, update: () -> Unit) {
            gotMid = mid
            update()
        }
        override fun stop() {}
    }

    /** What the bridge did: routed to a device (with the text it carried), or not routed at all. */
    private class Recorder {
        var routed: Pair<String, String>? = null
    }

    private fun bridge(host: Host, rec: Recorder): RemoteChatBridge =
        RemoteChatBridge(CoroutineScope(Dispatchers.Unconfined), host) { device, text, _ ->
            rec.routed = device.id to text
            Task()
        }

    @Test fun `no mention and a remote owner routes to the owner`() = runTest {
        val rec = Recorder()
        val task = Task()
        val b = RemoteChatBridge(CoroutineScope(Dispatchers.Unconfined), Host(owner = "desk")) { device, text, _ ->
            rec.routed = device.id to text
            task
        }

        assertTrue("an owner route is addressed here", b.send("tidy the downloads", listOf(desk), false, false))

        assertEquals("desk" to "tidy the downloads", rec.routed)
        // nanoMuse: the asked line's own row id rides along as `mid`, so the far device writes
        // that row instead of minting one of its own (§4.3). Without it the line — and the
        // answer — reach the relay twice and the chat shows the same turn twice.
        assertEquals("the row id of the line goes with the task", "mid-1", task.gotMid)
    }

    @Test fun `no mention and no owner runs here`() = runTest {
        val rec = Recorder()
        val b = bridge(Host(owner = null), rec)

        assertFalse(b.send("tidy the downloads", listOf(desk), false, false))
        assertNull(rec.routed)
    }

    @Test fun `an offline owner is refused, not silently run here`() = runTest {
        // the chat's owner is not in the account's device list any more. Running here would answer
        // with this phone's memory, which never held that chat's context — the person must be told.
        val host = Host(owner = "gone", name = "飞牛深圳")
        val rec = Recorder()
        val b = bridge(host, rec)

        assertTrue("a refusal is addressed here, so it must not fall into the local model", b.send("tidy the downloads", listOf(desk), false, false))

        assertNull("nothing is routed", rec.routed)
        assertEquals(RemoteChatBridge.Issue.OFFLINE, host.lastIssue)
        assertEquals("the message names the device, not its id", "飞牛深圳", host.lastIssueDevice)
        assertEquals("the draft comes back", "tidy the downloads", host.draft)
    }

    @Test fun `an offline owner with no name is refused by its id`() = runTest {
        val host = Host(owner = "gone")
        val rec = Recorder()
        val b = bridge(host, rec)

        assertTrue(b.send("tidy the downloads", listOf(desk), false, false))
        assertEquals(RemoteChatBridge.Issue.OFFLINE, host.lastIssue)
        assertEquals("gone", host.lastIssueDevice)
    }

    @Test fun `a mention still wins over the owner`() = runTest {
        val rec = Recorder()
        val b = bridge(Host(owner = "nas"), rec)

        assertTrue(b.send("@Desk do it there", listOf(desk), false, false))

        assertEquals("desk" to "do it there", rec.routed)
    }

    @Test fun `a mention of this phone runs here, the owner must not take it`() = runTest {
        // `@本机` resolves to no device: the person meant this phone, so the owner fallback must
        // not quietly hand the line to another device instead
        val rec = Recorder()
        val host = Host(owner = "desk", namesSelf = true)
        val b = bridge(host, rec)

        assertFalse(b.send("@本机 do it here", listOf(desk), false, false))
        assertNull(rec.routed)
        assertEquals("no refusal: `@本机` is not an error", null, host.lastIssue)
    }

    @Test fun `an @ naming no reachable device is refused, not answered here`() = runTest {
        // the device named is offline, or no device answers to that name: running the line here
        // would answer from this phone's memory a conversation it never held, which is what an
        // `@` to an unreachable device used to do. It is refused, and the draft comes back.
        val rec = Recorder()
        val host = Host(owner = "desk", namesSelf = false)
        val b = bridge(host, rec)

        assertTrue("a refusal is addressed here, so it must not fall into the local model", b.send("@nobody do it", listOf(desk), false, false))
        assertNull("nothing is routed", rec.routed)
        assertEquals(RemoteChatBridge.Issue.UNKNOWN_DEVICE, host.lastIssue)
        // the name as the person typed it, so the message can say which `@` reached nobody
        // rather than leaving a hole where the name belongs
        assertEquals("the name addressed rides with the refusal", "nobody", host.lastIssueDevice)
        assertEquals("the draft comes back", "@nobody do it", host.draft)
        assertNull("an unknown `@` is not this phone, so the owner does not move", host.tookHere)
    }

    @Test fun `a line naming no device asks the host to judge the owner`() = runTest {
        // the bridge cannot tell `@本机` from `@nobody`; it asks the host, which judges, so an
        // unknown `@` does not move the owner
        val host = Host(owner = "desk", namesSelf = true)
        val b = bridge(host, Recorder())

        b.send("@本机 do it here", listOf(desk), false, false)
        assertEquals("@本机 do it here", host.tookHere)
    }

    @Test fun `a line with no mention never asks the host to move the owner`() = runTest {
        val host = Host(owner = null)
        val b = bridge(host, Recorder())

        b.send("ordinary message", listOf(desk), false, false)
        assertNull(host.tookHere)
    }

    @Test fun `an ambiguous mention is refused, not handed to the owner`() = runTest {
        // two devices share the prefix: the person must disambiguate rather than have it silently
        // go to the owner. `@Pix` matches both `Pixel 8` and `Pixel 8 Pro` with no exact winner.
        val rec = Recorder()
        val b = bridge(Host(owner = "desk"), rec)
        val pixel = Device("p1", "Pixel 8", "phone", "Android", "", true, listOf("task"), 0)
        val pixelPro = Device("p2", "Pixel 8 Pro", "phone", "Android", "", true, listOf("task"), 0)

        assertTrue("a refusal still counts as addressed here", b.send("@Pix do it", listOf(pixel, pixelPro), false, false))
        assertNull(rec.routed)
    }

    @Test fun `a full name beats a shorter prefix, as upstream ranks it`() = runTest {
        // @Pixel 8 Pro is a different device from @Pixel 8; the owner must not override either
        val rec = Recorder()
        val b = bridge(Host(owner = "desk"), rec)
        val pixel = Device("p1", "Pixel 8", "phone", "Android", "", true, listOf("task"), 0)
        val pixelPro = Device("p2", "Pixel 8 Pro", "phone", "Android", "", true, listOf("task"), 0)

        assertTrue(b.send("@Pixel 8 open it", listOf(pixel, pixelPro), false, false))
        assertEquals("p1" to "open it", rec.routed)
    }
}
