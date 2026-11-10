package io.github.nanomuse.sync

import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The owner riding the wire and the mapping: the relay's two fields in `GET /v1/sync/changes`,
 * out again on a push, and kept with the chat (executor handoff v2, relay §A/§B).
 */
class OwnerSyncTest {
    // ── the wire shapes (pure JSON, no socket) ─────────────────────────────

    @Test fun `a conversation's owner fields are read off the relay's answer`() {
        val changes = SyncJson.changes(
            JSONObject(
                """{"cursor":9,"more":false,"conversations":[
                    {"cid":"c1","kind":"main","title":"Main","device":"phone-a","device_name":"Pixel",
                     "owner_device":"nas-1","owner_device_name":"飞牛深圳",
                     "created_at":1,"updated_at":2,"deleted":false,"seq":3}],
                   "messages":[]}""",
            ),
        )
        val c = changes.conversations.single()
        assertEquals("nas-1", c.ownerDevice)
        assertEquals("飞牛深圳", c.ownerDeviceName)
    }

    @Test fun `a relay from before the column reads as no owner`() {
        val changes = SyncJson.changes(
            JSONObject(
                """{"cursor":9,"more":false,"conversations":[
                    {"cid":"c1","kind":"main","title":"Main","device":"phone-a","device_name":"Pixel",
                     "created_at":1,"updated_at":2,"deleted":false,"seq":3}],
                   "messages":[]}""",
            ),
        )
        assertEquals("", changes.conversations.single().ownerDevice)
        assertEquals("", changes.conversations.single().ownerDeviceName)
    }

    @Test fun `a push carries the owner the phone holds`() {
        val body = SyncJson.pushBody(
            "phone-a",
            listOf(OutConversation("c1", "main", "Main", 1, 2, ownerDevice = "nas-1")),
            emptyList(),
        )
        assertEquals("nas-1", body.getJSONArray("conversations").getJSONObject(0).getString("owner_device"))
    }

    @Test fun `a push with no owner to report says nothing about it`() {
        // blank must not ride the wire: the relay keeps a real owner when the field is absent
        val body = SyncJson.pushBody("phone-a", listOf(OutConversation("c1", "main", null, 1, 2)), emptyList())
        val conv = body.getJSONArray("conversations").getJSONObject(0)
        assertFalse(conv.has("owner_device"))
    }

    // ── the mapping (engine over the fake relay) ───────────────────────────

    private class Phone(val relay: FakeRelay, val device: String) {
        val store = MemorySyncStore()
        val chats = MemoryChats()
        var clock = 1_700_000_000_000L
        val engine = SyncEngine(store, chats, relay, device, "acct-1", now = { clock }, sideChats = { true })
    }

    /** A chat another device started on the relay, with an owner already on it. */
    private fun seeded(relay: FakeRelay, owner: String): FakeRelay {
        relay.seed("nas-1", "c1", "main", "Main", 1_700_000_000).ownerDevice = owner
        return relay
    }

    @Test fun `a pull stores the owner on the chat`() = runTest {
        val relay = seeded(FakeRelay(mapOf("nas-1" to "飞牛深圳")), owner = "nas-1")
        val p = Phone(relay, "phone-a")

        p.engine.pull()

        val map = p.store.convs.values.single { it.cid == "c1" }
        assertEquals("nas-1", map.ownerDevice)
        assertEquals("飞牛深圳", map.ownerDeviceName)
        // and the caller's view of the owners has it, keyed by the local chat
        assertEquals(DeviceOwner.Device("nas-1", "飞牛深圳"), p.engine.owners()[map.sessionId])
    }

    @Test fun `the owner moving on another device follows the pull`() = runTest {
        val relay = seeded(FakeRelay(mapOf("nas-1" to "飞牛深圳", "phone-a" to "Pixel")), owner = "phone-a")
        val p = Phone(relay, "phone-a")
        p.engine.pull()
        assertEquals("phone-a", p.store.convs.values.single { it.cid == "c1" }.ownerDevice)

        // the NAS ran the turn there and reported itself as the owner
        relay.convs.getValue("c1").ownerDevice = "nas-1"
        relay.convs.getValue("c1").seq = ++relay.seq
        p.engine.pull()

        assertEquals("nas-1", p.store.convs.values.single { it.cid == "c1" }.ownerDevice)
        assertEquals("飞牛深圳", p.store.convs.values.single { it.cid == "c1" }.ownerDeviceName)
        assertEquals("nas-1", p.engine.owners().values.single().id)
    }

    @Test fun `this phone reports itself as the owner of a chat it mints`() = runTest {
        val relay = FakeRelay()
        val p = Phone(relay, "phone-a")
        p.chats.addSession("main"); p.chats.main = "main"
        p.chats.user("main", "hi")

        p.engine.push()

        assertEquals("phone-a", relay.convs.getValue(p.store.convs.getValue("main").cid).ownerDevice)
    }

    @Test fun `a pull never clears a real owner with a blank one`() = runTest {
        // an older relay, or a row pushed before the column existed, must not take the owner away
        val relay = seeded(FakeRelay(), owner = "nas-1")
        val p = Phone(relay, "phone-a")
        p.engine.pull()
        assertEquals("nas-1", p.store.convs.values.single { it.cid == "c1" }.ownerDevice)

        // the relay's field goes quiet (a row that predates the column): the owner this phone
        // already holds stands, and the next push reports it back so the relay keeps it
        relay.convs.getValue("c1").ownerDevice = ""
        relay.convs.getValue("c1").seq = ++relay.seq
        p.engine.pull()

        assertEquals("nas-1", p.store.convs.values.single { it.cid == "c1" }.ownerDevice)
        assertEquals("nas-1", p.engine.owners().values.single().id)
    }

    @Test fun `a chat under another account is not in this account's owners`() = runTest {
        val relay = seeded(FakeRelay(), owner = "nas-1")
        val p = Phone(relay, "phone-a")
        p.engine.pull()
        val session = p.store.convs.values.single { it.cid == "c1" }.sessionId

        // the mapping is moved to another account: its owner must not surface for this one
        p.store.convs[session] = p.store.convs.getValue(session).copy(owner = "acct-2")
        assertTrue(p.engine.owners().isEmpty())
    }

    // ── claim: this phone ran the turn, so the context is here now (§4.1) ──

    @Test fun `claiming a chat the NAS owned moves the owner here and reports it back`() = runTest {
        val relay = seeded(FakeRelay(), owner = "nas-1")
        val p = Phone(relay, "phone-a")
        p.engine.pull()
        val session = p.store.convs.values.single { it.cid == "c1" }.sessionId
        assertEquals("nas-1", p.engine.owners().getValue(session).id)

        val changed = p.engine.claim(session, "Pixel")

        assertTrue("the owner moved, so there is something to push", changed)
        assertEquals("phone-a", p.store.convs.getValue(session).ownerDevice)
        assertEquals("phone-a", p.engine.owners().getValue(session).id)

        p.engine.push()
        assertEquals("phone-a", relay.convs.getValue("c1").ownerDevice)
    }

    @Test fun `claiming a chat this phone already owns changes nothing`() = runTest {
        val relay = seeded(FakeRelay(), owner = "phone-a")
        val p = Phone(relay, "phone-a")
        p.engine.pull()
        val session = p.store.convs.values.single { it.cid == "c1" }.sessionId

        assertFalse(p.engine.claim(session, "Pixel"))
    }

    @Test fun `claiming a chat the relay never mapped changes nothing`() = runTest {
        val relay = FakeRelay()
        val p = Phone(relay, "phone-a")
        // a local chat that was never pushed has no mapping to own
        assertFalse(p.engine.claim("no-such-session", "Pixel"))
    }

    @Test fun `claiming a chat under another account is refused`() = runTest {
        val relay = seeded(FakeRelay(), owner = "nas-1")
        val p = Phone(relay, "phone-a")
        p.engine.pull()
        val session = p.store.convs.values.single { it.cid == "c1" }.sessionId
        p.store.convs[session] = p.store.convs.getValue(session).copy(owner = "acct-2")

        assertFalse("another account's chat is not this one's to take (C10)", p.engine.claim(session, "Pixel"))
        assertEquals("nas-1", p.store.convs.getValue(session).ownerDevice)
    }
}
