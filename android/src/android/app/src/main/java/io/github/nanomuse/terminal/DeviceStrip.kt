package io.github.nanomuse.terminal

import io.github.nanomuse.hub.Device
import io.github.nanomuse.reach.Computers

/**
 * The account's Muses as the chat draws them: the row of faces above the box, this phone's own
 * among them.
 *
 * The devices are the hub's own list, not `Computers.hubDevices`: that one answers "where may a
 * command go right now" and keeps only what is online, while the faces have to show the
 * sleeping ones too (faint) for the person to know why a tap on them would not go anywhere.
 *
 * What the `@` picker offers is not here: since the upstream merge the device rows of the menu
 * are built by `io.github.nanomuse.sync.DeviceMentionMenu`, which reads the leading `@` and the
 * caret and qualifies duplicate names with their ids.
 */
object DeviceStrip {
    /**
     * Every Muse of the account, in the order the row draws them: this phone first (it is the
     * one being held, and the one a chat with no device of its own belongs to), then the other
     * devices, the online ones by name ahead of the sleeping ones.
     *
     * Browser tabs are left out — there is nothing there to talk to — and so is a nameless
     * entry. The phone is *in*, because the row is the account's Muses and its own face is one
     * of them: picking it is how a chat goes back to being this phone's own.
     */
    fun muses(all: List<Device>): List<Computers.Computer> = all
        .filter { it.name.isNotBlank() && it.kind != "web" }
        .sortedWith(
            compareBy(
                { if (it.isThis) 0 else 1 },
                { if (it.online) 0 else 1 },
                { it.name.lowercase() },
            ),
        )
        .map(::asComputer)

    /**
     * The devices that may be written to: every Muse but this phone, which is the chat rather
     * than something the chat talks to. What the `@` picker offers and what a send resolves an
     * aim against.
     */
    fun others(all: List<Device>): List<Computers.Computer> = all
        .filter { it.name.isNotBlank() && it.kind != "web" && !it.isThis }
        .sortedWith(compareBy({ if (it.online) 0 else 1 }, { it.name.lowercase() }))
        .map(::asComputer)

    /**
     * The device whose face the strip draws large, as a position in [all]'s own order, or -1 when
     * there is nothing to draw.
     *
     * [focusedHubId] is the device the open chat is addressed to, and blank means the phone
     * itself: a chat with no device of its own is this phone's chat, so *its* face is the one in
     * front. Resolving the blank here is what keeps the phone's own face drawn large in the main
     * chat — matching a blank id against the list finds nobody, and the strip would draw every
     * face at its idle size with nothing in front.
     */
    fun focusIndex(all: List<Device>, focusedHubId: String): Int {
        val everyone = muses(all)
        if (focusedHubId.isNotBlank()) {
            val i = everyone.indexOfFirst { it.hubId == focusedHubId }
            if (i >= 0) return i
        }
        return everyone.indexOfFirst { it.isThis }
    }

    /**
     * The row as the header draws it: the face in the middle, the faces to its left, and the
     * faces to its right. [focusedHubId] is the device the open chat is addressed to, or empty
     * for the phone itself, which is the middle face in that case.
     *
     * The split is by count, so the two sides are of like width and the middle face stays in the
     * middle of the bar; nothing about the devices themselves decides it. This is the one place
     * the arrangement is decided, so the phone and the console cannot draw the same account two
     * different ways.
     */
    fun sides(
        all: List<Device>,
        focusedHubId: String,
        phoneId: String,
    ): Row {
        val everyone = muses(all)
        val want = focusedHubId.ifBlank { phoneId }
        val middle = everyone.firstOrNull { it.hubId == want }
            ?: everyone.firstOrNull { it.hubId == phoneId }
            ?: everyone.firstOrNull()
        val rest = everyone.filter { it.hubId != middle?.hubId }
        val half = (rest.size + 1) / 2
        return Row(middle = middle, left = rest.take(half), right = rest.drop(half))
    }

    /** The header's row: whose face is in the middle, and which are on either side of it. */
    data class Row(
        val middle: Computers.Computer?,
        val left: List<Computers.Computer>,
        val right: List<Computers.Computer>,
    )

    /**
     * The devices the `@` picker offers for [prefix], the online ones first and the ones whose
     * name begins with what was typed ahead of the ones that merely contain it (the same ranking
     * iOS uses), capped so a picker stays a picker. An empty prefix offers everything, which is
     * what the person gets the moment they type `@`.
     */
    fun suggestions(devices: List<Computers.Computer>, prefix: String, limit: Int = 6): List<Computers.Computer> {
        val p = prefix.trim().lowercase()
        return devices
            .filter { p.isEmpty() || it.name.lowercase().contains(p) }
            .sortedWith(
                compareBy(
                    { if (it.online) 0 else 1 },
                    { if (it.name.lowercase().startsWith(p)) 0 else 1 },
                    { it.name.lowercase() },
                ),
            )
            .take(limit)
    }

    /**
     * What was typed after a leading `@`, or null when the text is not a mention in progress.
     * The picker's filter, read the way the `@` picker upstream reads it
     * (`ChatViewModelMentionExt.updateMentionMenuState`: everything from the `@` to the caret,
     * spaces and all, so `@Mac mini` still finds the device of that name). The `@` has to open
     * the message, which is the only place [DeviceTargetMention.reading] looks for one, so the
     * picker cannot offer a device the send would not address.
     */
    fun afterAt(text: String): String? {
        val body = text.trimStart()
        if (!body.startsWith("@")) return null
        return body.substring(1)
    }

    /**
     * The short label a face wears under its disc on the device strip. A name longer than [limit]
     * is cut to the first [limit] characters and a single ellipsis, so the label fits on one line
     * and every disc stays on the same level. Only the strip draws this: the full name is still
     * what the disc reads out as its content description and what the `@` picker matches against.
     */
    fun displayName(name: String, limit: Int = 9): String =
        if (name.length <= limit) name else name.take(limit) + "…"

    private fun asComputer(d: Device) = Computers.Computer(
        id = "hub:" + d.id,
        name = d.name,
        os = d.os,
        hubId = d.id,
        kind = d.kind,
        online = d.online,
        lastSeen = d.lastSeen,
        // the face of the phone being held wears "This device" rather than the account's name
        // for it (see DeviceFacesRow), which is why the flag has to survive this mapping
        isThis = d.isThis,
    )
}
