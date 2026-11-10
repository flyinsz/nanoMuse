package io.github.nanomuse.sync

import android.content.Context
import com.openminis.app.R

/**
 * Who runs the next turn of a chat (executor handoff v2, `docs/tasks/executor-handoff-v2.md` §4.1).
 *
 * The relay keeps one `owner_device` per conversation: the device that ran the conversation's
 * last turn, and so the only device holding its full context (tool traces, reasoning and pictures
 * stay in that device's own thread file — sync carries plain text only). The next sentence
 * therefore belongs to the owner, not to whoever is looking: a chat the NAS ran says the NAS will
 * run the next one, and the composer's placeholder names it.
 *
 * Everything here is a pure function of the fields the relay reported, so the rule can be checked
 * with JUnit and no Android runtime. The Android wiring — reading the owner off a stored mapping
 * and drawing the placeholder over the composer — is the caller's.
 */
object DeviceOwner {

    /** A device the account lists, as the relay names it. */
    data class Device(val id: String, val name: String)

    /** Where a turn would run: here, or on another device of the account. */
    sealed interface Target {
        /** This phone — the main chat's own Muse, and the answer when nobody else is named. */
        data object Local : Target

        /** Another device of the account; [name] is what the relay calls it. */
        data class Remote(val id: String, val name: String) : Target
    }

    /**
     * The owner a conversation row carries, or null when the relay did not say: an older relay, or
     * a row pushed before the column existed. A blank name is kept blank; [placeholder] then falls
     * back to the id so it still names something.
     */
    fun of(ownerDevice: String, ownerDeviceName: String): Device? {
        val id = ownerDevice.trim()
        if (id.isEmpty()) return null
        return Device(id = id, name = ownerDeviceName.trim())
    }

    /** nanoMuse: the owner of one conversation as the relay list it (`GET /v1/sync/changes`). */
    fun of(remote: RemoteConversation): Device? = of(remote.ownerDevice, remote.ownerDeviceName)

    /** nanoMuse: the owner this phone remembers for one of its chats (the stored mapping). */
    fun of(stored: SyncConversation): Device? = of(stored.ownerDevice, stored.ownerDeviceName)

    /**
     * Where the next turn of a conversation runs, from the relay's `owner_device` and this phone's
     * own hub id.
     *
     * A blank owner is [Target.Local]: the rule that the default executor is the recent owner
     * cannot name anyone the account never told us about, and a phone that never synced a chat
     * runs it itself, exactly as before. An owner that is this phone is [Target.Local] too — the
     * ordinary path, with no handoff on the wire.
     */
    fun target(ownerDevice: String, selfId: String): Target {
        val id = ownerDevice.trim()
        if (id.isEmpty() || id == selfId) return Target.Local
        return Target.Remote(id = id, name = "")
    }

    /**
     * [target] with a name for a remote device, from the conversation's own `owner_device_name`.
     * This phone's name is left as it is: [Target.Local] is drawn with its own wording, never the
     * device's account name, because "本机" is what the person typed to get back here.
     */
    fun named(target: Target, ownerDevice: String, ownerDeviceName: String): Target {
        if (target !is Target.Remote) return target
        val name = ownerDeviceName.trim().ifEmpty { ownerDevice.trim() }
        return target.copy(name = name)
    }

    /** The one call the caller usually wants: `target` and `named` together, in one step. */
    fun resolve(ownerDevice: String, ownerDeviceName: String, selfId: String): Target =
        named(target(ownerDevice, selfId), ownerDevice, ownerDeviceName)

    /** The word the person types to name this phone (§4.2 rule 3). */
    const val SELF_WORD = "本机"

    /**
     * The words that name this phone on their own, one per locale that offers one: 简体中文's
     * `@本机` and English's `@This device` — the two the composer's placeholder can show
     * (`R.string.nm_executor_self`). A locale whose placeholder says something else still
     * reaches this phone by its own account name; only these two are recognised as this device
     * with no name behind them. Matched without case, and the runtime's own list is the same
     * two words (`nanomuse/sync/mention.py`), so a line means the same thing on every client.
     */
    private val SELF_WORDS = listOf(SELF_WORD, "this device")

    /**
     * Whether a line that names this phone rather than another device — `@本机`, or `@` with this
     * device's own account name (`@Pixel 8`) — (executor handoff v2 §4.2 rule 3).
     *
     * The bridge cannot decide this: `RemoteDeviceRoute` keeps this phone out of the account's
     * device list, so `@本机` and an unknown `@nobody` both come back as no device. This is the
     * judgement that tells them apart, and it errs on the side of *not* moving the owner: a line
     * with no leading `@`, or an `@` naming anything this phone cannot be sure of, is false. The
     * person's line then keeps the owner it had, which is the safe reading — nobody asked for the
     * context to move.
     *
     * [selfName] is this device's own account name; blank is fine (only `@本机` matches then).
     */
    fun addressesSelf(text: String, selfName: String): Boolean {
        val body = text.trimStart()
        if (!body.startsWith("@")) return false
        val rest = body.substring(1)
        // `@本机` (and `@This device`) are fixed words, so the next character decides: "@本机子"
        // is some other device, "@本机 do it" and "@本机，做这个" are this phone. Case is ignored,
        // so the English placeholder's "@This device" is recognised however it is typed.
        for (word in SELF_WORDS) {
            if (rest.length >= word.length && rest.regionMatches(0, word, 0, word.length, ignoreCase = true) && boundary(rest, word.length)) {
                return true
            }
        }
        // An account name may itself contain spaces ("Pixel 8 Pro"), so a space is not a safe
        // boundary: only an exact match or one the person punctuated off — "@Pixel 8: do it" —
        // counts. "@Pixel 8 Pro" must not read as this phone when this phone is "Pixel 8".
        val name = selfName.trim()
        if (name.isEmpty()) return false
        if (rest.equals(name, ignoreCase = true)) return true
        if (!rest.startsWith(name, ignoreCase = true)) return false
        return rest.getOrNull(name.length)?.let { it in SEPARATORS } == true
    }

    /** The name ends where the word does: "@Mac" names the Mac, "@Macbook" does not. */
    private fun boundary(body: String, n: Int): Boolean =
        n >= body.length || !(body[n].isLetterOrDigit() || body[n] == '_' || body[n] == '-')

    /** What the person types after a device name to move on: "@Mac: build it", "@Mac, go". */
    private val SEPARATORS = charArrayOf(':', '：', ',', '，', ';', '；')

    /**
     * The composer's placeholder for [target], `@…` and all.
     *
     * [selfLabel] is the localised word for this phone with its own `@` already on it
     * (`R.string.nm_executor_self`), and [deviceFormat] wraps another device's name
     * (`R.string.nm_executor_device`, an `@%1$s` template). Both come in as arguments so this
     * stays a pure function: the resource lookup belongs to the UI, not to the rule.
     *
     * A remote device whose name is blank is named by its id — the id is what `@…` addresses on
     * the wire anyway, so the placeholder cannot promise a switch it could not carry out.
     */
    fun placeholder(target: Target, selfLabel: String, deviceFormat: (String) -> String): String = when (target) {
        Target.Local -> selfLabel
        is Target.Remote -> deviceFormat(target.name.ifBlank { target.id })
    }

    /**
     * [placeholder] with this app's own strings. The only Android-aware entry point here, kept
     * apart so everything above it can be unit-tested without a Context.
     */
    fun placeholder(context: Context, ownerDevice: String, ownerDeviceName: String, selfId: String): String =
        placeholder(
            target = resolve(ownerDevice, ownerDeviceName, selfId),
            selfLabel = context.getString(R.string.nm_executor_self),
            deviceFormat = { name -> context.getString(R.string.nm_executor_device, name) },
        )
}
