package io.github.nanomuse.hub

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * What a `task` frame's attachment references come to before anything touches the phone
 * (executor handoff v2, topic B2): which entries are usable, what the file is called on
 * disk, whether it is a picture, and what the prompt says about a file that did not come.
 */
class HubAttachmentsTest {

    // ── the reference ─────────────────────────────────────────────────────

    @Test fun `a good reference keeps its hash, name and type`() {
        val ref = HubAttachments.ref("a".repeat(64), "report.pdf", "application/pdf", 12345)
        assertEquals("a".repeat(64), ref?.sha256)
        assertEquals("report.pdf", ref?.name)
        assertEquals("application/pdf", ref?.mime)
        assertEquals(12345L, ref?.size)
    }

    @Test fun `a hash that is not a hash names no file`() {
        assertNull(HubAttachments.ref("", "a.pdf", "application/pdf", 0))
        assertNull(HubAttachments.ref("zz".repeat(32), "a.pdf", "application/pdf", 0))
        assertNull(HubAttachments.ref("a".repeat(63), "a.pdf", "application/pdf", 0))
        assertNull(HubAttachments.ref("a".repeat(65), "a.pdf", "application/pdf", 0))
        assertNull(HubAttachments.ref("abc123", "a.pdf", "application/pdf", 0))
        // an upper-case hash is the same hash
        assertEquals("a".repeat(64), HubAttachments.ref("A".repeat(64), "a.pdf", "", 0)?.sha256)
        assertEquals("a".repeat(64), HubAttachments.ref("  ${"a".repeat(64)}  ", "a.pdf", "", 0)?.sha256)
    }

    @Test fun `a missing type is read from the name`() {
        assertEquals("image/png", HubAttachments.ref("a".repeat(64), "shot.png", "", 0)?.mime)
        assertEquals("image/png", HubAttachments.ref("a".repeat(64), "shot.png", "   ", 0)?.mime)
        assertEquals("application/pdf", HubAttachments.ref("a".repeat(64), "doc.pdf", "", 0)?.mime)
        assertEquals("application/octet-stream", HubAttachments.ref("a".repeat(64), "blob.xyzzy", "", 0)?.mime)
    }

    @Test fun `a name sent by another device cannot leave the folder`() {
        val sha = "b".repeat(64)
        assertEquals("report.pdf", HubAttachments.safeName("report.pdf", sha))
        // the last path component is the name (`Path(name).name` on the asking side), and what is
        // left collapses, so nothing survives that could steer the write out of the folder
        assertEquals("passwd", HubAttachments.safeName("../../etc/passwd", sha))
        assertEquals("evil.txt", HubAttachments.safeName("..\\..\\windows\\evil.txt", sha))
        assertEquals("a b.txt", HubAttachments.safeName("a b.txt", sha))
        // a control character is not one of the kept ones: it collapses, like any other
        assertEquals("a_b.txt", HubAttachments.safeName("a\u0000b.txt", sha))
        // `save_upload`'s rule exactly: word characters (CJK too), dots, dashes, spaces, brackets
        assertEquals("报告 (1).pdf", HubAttachments.safeName("报告 (1).pdf", sha))
        assertEquals("レポート-2_v3.MD", HubAttachments.safeName("レポート-2_v3.MD", sha))
        assertEquals("a(b)-c d.pdf", HubAttachments.safeName("a(b)-c d.pdf", sha))
        // a name that is nothing but separators and dots is no name at all: the hash stands in
        assertEquals("attachment-${sha.take(12)}", HubAttachments.safeName("../..", sha))
        assertEquals("attachment-${sha.take(12)}", HubAttachments.safeName("", sha))
        assertEquals("attachment-${sha.take(12)}", HubAttachments.safeName("...", sha))
        // leading dots/underscores/spaces go, so no hidden or stray-looking file is made
        assertEquals("a.txt", HubAttachments.safeName("  .._a.txt  ", sha))
        // and it cannot be longer than a file name should be
        assertEquals(120, HubAttachments.safeName("x".repeat(300), sha).length)
    }

    // ── picture or document ───────────────────────────────────────────────

    @Test fun `the sender's type decides what the agent sees`() {
        assertTrue(HubAttachments.isImage("image/png", "a.bin"))
        assertTrue(HubAttachments.isImage("image/jpeg", "noext"))
        assertTrue(HubAttachments.isImage("IMAGE/PNG", "a.bin"))
        assertFalse(HubAttachments.isImage("application/pdf", "a.pdf"))
        assertFalse(HubAttachments.isImage("text/plain", "a.txt"))
        assertFalse(HubAttachments.isImage("video/mp4", "a.mp4"))
    }

    @Test fun `a frame with no type falls back to the name, and a meaningless type defers to it`() {
        assertTrue(HubAttachments.isImage("", "shot.png"))
        assertTrue(HubAttachments.isImage("", "shot.JPEG"))
        assertFalse(HubAttachments.isImage("", "doc.pdf"))
        assertFalse(HubAttachments.isImage("", "noext"))
        // `application/octet-stream` is what an unknown type becomes: the name still knows
        assertTrue(HubAttachments.isImage("application/octet-stream", "shot.png"))
        assertFalse(HubAttachments.isImage("application/octet-stream", "doc.pdf"))
    }

    @Test fun `the types the hub already knew, and the phone's own pictures`() {
        assertEquals("image/png", HubAttachments.guessMime("a.png"))
        assertEquals("image/jpeg", HubAttachments.guessMime("a.jpg"))
        assertEquals("image/jpeg", HubAttachments.guessMime("a.jpeg"))
        assertEquals("image/gif", HubAttachments.guessMime("a.gif"))
        assertEquals("image/webp", HubAttachments.guessMime("a.webp"))
        assertEquals("image/heic", HubAttachments.guessMime("a.heic"))
        assertEquals("application/pdf", HubAttachments.guessMime("a.pdf"))
        assertEquals("text/plain", HubAttachments.guessMime("a.txt"))
        assertEquals("text/markdown", HubAttachments.guessMime("a.md"))
        assertEquals("application/json", HubAttachments.guessMime("a.json"))
        assertEquals("text/csv", HubAttachments.guessMime("a.csv"))
        assertEquals("application/octet-stream", HubAttachments.guessMime("a.xyzzy"))
        assertEquals("application/octet-stream", HubAttachments.guessMime("noext"))
    }

    // ── the hash ──────────────────────────────────────────────────────────

    @Test fun `a file's hash is the hex the relay stores it by`() {
        // the SHA-256 of the empty input, and of "abc"
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", HubAttachments.sha256(ByteArray(0)))
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", HubAttachments.sha256("abc".toByteArray()))
    }

    // ── what the model is told ────────────────────────────────────────────

    @Test fun `a prompt with nothing missing is the prompt it always was`() {
        assertEquals("do it", HubAttachments.withMissed("do it", emptyList()))
        assertEquals("From Desk.\n\ndo it", HubAttachments.withMissed("From Desk.\n\ndo it", emptyList()))
    }

    @Test fun `a prompt names the files that did not come`() {
        val out = HubAttachments.withMissed("do it", listOf("report.pdf"))
        assertTrue(out.startsWith("do it"))
        assertTrue(out.contains("report.pdf"))
        assertTrue(out.contains("missing"))
        val many = HubAttachments.withMissed("do it", listOf("a.pdf", "b.png"))
        assertTrue(many.contains("a.pdf, b.png"))
        // the request itself is never rewritten, only appended to
        assertEquals(2, many.split("\n\n").size)
    }

    // ── where a second file of one name lands ─────────────────────────────

    @Test fun `free path never writes over a name that is taken`() {
        val dir = File(System.getProperty("java.io.tmpdir"), "nm-free/${System.nanoTime()}").apply { mkdirs() }
        assertEquals("a.txt", HubAttachments.freePath(dir, "a.txt").name)
        File(dir, "a.txt").writeText("x")
        assertEquals("a (2).txt", HubAttachments.freePath(dir, "a.txt").name)
        File(dir, "a (2).txt").writeText("x")
        assertEquals("a (3).txt", HubAttachments.freePath(dir, "a.txt").name)
        // no extension: the suffix goes at the end
        File(dir, "noext").writeText("x")
        assertEquals("noext (2)", HubAttachments.freePath(dir, "noext").name)
        // a leading dot is not an extension split point
        File(dir, ".hidden").writeText("x")
        assertEquals(".hidden (2)", HubAttachments.freePath(dir, ".hidden").name)
    }
}
