package io.github.nanomuse.terminal

import android.content.Context
import io.github.nanomuse.reach.Computers

/**
 * `@Mac tidy the downloads folder`: the person addressed another device of the account, and
 * the message is work for that device. This decides that, so the message can go straight to
 * that device's own Muse over the hub (`task`) instead of opening a turn here.
 *
 * The matching rules are `nanomuse/sync/mention.py` (`parse_mention`), the runtime's own
 * reading of the same line, so a message a phone sends and the same message a browser sends
 * address the same device. Kept in step with `web/src/mention.ts` and the iPhone's
 * `NanoMuseDeviceMention`. [reading] is the rule on its own, for the unit tests; [parse]
 * gives it this phone's online devices.
 *
 * Which of the two paths a message takes is not a matter of taste. A mention handed to the
 * local Muse is a note in the system prompt asking the model to relay it with
 * `nanomuse-pc task`: the model still runs a whole turn, it may reword what was asked, and
 * nothing stops it doing the work itself. Sending the frame directly costs no turn and cannot
 * be reinterpreted. [io.github.nanomuse.sync.DeviceMention] keeps the note path for
 * everything this does not take.
 */
object DeviceTargetMention {
    /** A device that was addressed, and what is left of the message once the mention is gone. */
    data class Hit(val device: Computers.Computer, val text: String)

    /** The named device read out of a message, before it is tied to a device of the account. */
    data class Named(val name: String, val text: String)

    private val separators = setOf(' ', '\t', ',', ':', ';', '，', '：', '；')

    /**
     * The device [text] addresses, when it addresses one this phone can reach, with the
     * mention taken out. Null when the message is not a mention, names nobody, or is a
     * mention and nothing else: an empty task is not a task, so the caller leaves the text
     * as it was and the ordinary path takes it.
     */
    fun parse(context: Context, text: String): Hit? {
        val devices = Computers.all(context)
        if (devices.isEmpty()) return null
        val named = reading(text, devices.map { it.name }) ?: return null
        val device = devices.firstOrNull { it.name.trim().equals(named.name, ignoreCase = true) }
            ?: return null
        return Hit(device, named.text)
    }

    /**
     * The rule, on names alone: which of [names] a message that opens with `@` addresses, and
     * what is left once the mention is gone. Null when it addresses none, or when the mention
     * was the whole message.
     *
     * A whole name at the start wins, the longest when two names share a start; failing that
     * the first word after `@` as the start of exactly one name, which is `mention.py`'s own
     * order, so `@Mac` picks between "Mac" and "Mac mini" by what was typed rather than by
     * which of them happens to be listed first.
     */
    fun reading(text: String, names: List<String>): Named? {
        val body = text.trimStart()
        if (!body.startsWith("@") || body.length < 2) return null
        val rest = body.substring(1)

        val whole = names
            .map { it.trim() }
            .filter { it.isNotEmpty() && endsAtBoundary(rest, it) }
            .maxByOrNull { it.length }
        if (whole != null) return cut(whole, rest, whole.length)

        val word = rest.takeWhile { it !in separators }
        if (word.isEmpty()) return null
        val hits = names.map { it.trim() }.filter { it.isNotEmpty() && startsWith(rest, it, word) }
        val name = hits.singleOrNull() ?: return null
        return cut(name, rest, word.length)
    }

    /** The way `mention.py` reads a name at the start: case-insensitively, then a separator. */
    private fun endsAtBoundary(rest: String, name: String): Boolean =
        rest.length >= name.length && rest.regionMatches(0, name, 0, name.length, ignoreCase = true) &&
            (rest.length == name.length || rest[name.length] in separators)

    /** A name whose start is what was typed, `@mac` naming "MacBook Pro". */
    private fun startsWith(rest: String, name: String, word: String): Boolean =
        name.length >= word.length && name.regionMatches(0, word, 0, word.length, ignoreCase = true)

    private fun cut(name: String, rest: String, used: Int): Named? {
        val remainder = rest.substring(used).trimStart { it.isWhitespace() || it in separators }
        if (remainder.isBlank()) return null
        return Named(name, remainder)
    }
}
