package io.github.nanomuse.sync

import java.security.MessageDigest

/**
 * The message id a sentence is given when this phone hands it to another device (contract C13,
 * impl §3, "单次推送（单 mid）").
 *
 * A handed-off round is run *on the other device*, which writes its own `user` row for the
 * sentence and pushes it. This phone writes that same sentence into its own chat at once, before
 * anything has left — a line the person watches. Two rows for one sentence means two devices
 * pushing it: the relay files the first and quietly drops the second by `mid`
 * (`sync.py`, a known `mid` is skipped), but if the two rows carry *different* mids both land,
 * every device reads the sentence twice, and the asking model's own context holds it twice.
 *
 * So the id is minted here, handed to the target in the `task` frame, and written on this phone's
 * row: whoever pushes first, the relay keeps one row and every reader recognises it.
 *
 * Derived rather than random so a retry of the same line lands on the same id, exactly as the
 * desktop's `deriveMid` does (`harness/dsh-nanomuse/src/sync.ts`). The three parts are the same
 * ones it uses; a session id and a row id are this phone's own, which is all the stability asked
 * for is about — one device, one line, one id.
 *
 * The shape fits what a relay accepts (`valid_id`: `^[a-z0-9][a-z0-9._:-]{3,63}$`): 32 lowercase
 * hex characters.
 */
object HandoffMid {
    fun of(device: String, sessionId: String, lineId: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val seed = "$device\u0000$sessionId\u0000$lineId"
        return digest.digest(seed.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
            .take(32)
    }
}
