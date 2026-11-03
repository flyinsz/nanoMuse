package io.github.nanomuse.terminal

import com.openminis.app.data.FileMentionIndex
import io.github.nanomuse.hub.Device
import io.github.nanomuse.hub.Hub

/**
 * The account's other devices, as the chat draws them twice over: the strip of avatars above
 * the composer, and the devices the `@` picker offers above the files it already lists.
 *
 * Why both. The mention is a reading of what was typed, so it can only offer a device whose
 * name the person already knows and can spell; Android's picker listed files alone before
 * this, so a device could only be reached by typing its name exactly, which is the whole cost
 * of the feature on a phone. The strip says who is reachable at a glance, in one tap; the
 * picker says it while a name is being typed. They answer the same question and must not
 * disagree, so the rule lives here once.
 *
 * The devices are the hub's own list, not `Computers.hubDevices`: that one answers "where may a
 * command go right now" and so keeps only what is online, while a strip has to show the
 * sleeping ones too (greyed) for the person to know why a task to them would not go.
 *
 * A tap on the strip does what a mention does: [RemoteTaskController] sends the frame and the
 * chat shows the run. Nothing here changes a chat's target: a chat's device is set when it is
 * made and never moves, so a device already talked to is returned to.
 */
object DeviceStrip {
    /** One device of the strip: which to draw, and whether it is the one being talked to. */
    data class Chip(val device: Device, val focused: Boolean)

    /** This phone and any browser tab are left out: neither can take a task. */
    fun devices(all: List<Device>): List<Device> =
        all.filter { it.name.isNotBlank() && it.kind != "web" }

    /**
     * The devices the strip lists, in the order it draws them: the one the open chat is
     * addressed to first (it is the enlarged one, and should not move as the person switches
     * chats), then the online ones by name, then the offline ones by name.
     *
     * Offline devices are kept and drawn greyed rather than hidden: a device that is merely
     * asleep is still one of the person's.
     */
    fun strip(devices: List<Device>, chatDevice: String): List<Chip> =
        devices
            .sortedWith(
                compareBy(
                    { if (chatDevice.isNotBlank() && it.id == chatDevice) 0 else 1 },
                    { if (it.online) 0 else 1 },
                    { it.name.lowercase() },
                ),
            )
            .map { Chip(it, chatDevice.isNotBlank() && it.id == chatDevice) }

    /**
     * The devices the `@` picker offers for [prefix], the online ones first and the ones whose
     * name begins with what was typed ahead of the ones that merely contain it (the same
     * ranking iOS uses), capped so a picker stays a picker. An empty prefix offers everything,
     * which is what the person gets the moment they type `@`.
     */
    fun suggestions(devices: List<Device>, prefix: String, limit: Int = 6): List<Device> {
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
     * The devices as rows of the `@` picker, above the files it already lists. The row's
     * `linuxPath` is the device's name, so picking it writes `@<name> ` — exactly what
     * [DeviceTargetMention.reading] reads back when the message is sent, which is how the
     * picker and the send stay in step without either knowing about the other.
     *
     * The badge says "device" (`mountName`), so the row reads as one of the account's
     * computers or phones rather than a folder; the second line is the system and whether the
     * device is up (the same pair the computers panel shows), since the row's title is
     * already the name.
     */
    fun entries(
        context: android.content.Context,
        filter: String,
        limit: Int = 6,
    ): List<FileMentionIndex.Entry> {
        val up = context.getString(com.openminis.app.R.string.nm_pc_online)
        val down = context.getString(com.openminis.app.R.string.nm_pc_offline)
        return suggestions(devices(Hub.devices.value), filter, limit).map { d ->
            FileMentionIndex.Entry(
                linuxPath = d.name,
                scope = FileMentionIndex.Scope.MOUNT,
                mountName = DEVICE_BADGE,
                modifiedAt = d.lastSeen,
                isDirectory = false,
                nmDeviceDetail = listOf(d.os, if (d.online) up else down)
                    .filter { it.isNotBlank() }
                    .joinToString(" · "),
            )
        }
    }

    /**
     * The badge the picker's device rows carry, so the view can tell them from files and draw
     * the device icon instead of the document one. English and lower case like the scope
     * labels beside it ("skills", "workspace").
     */
    const val DEVICE_BADGE = "device"
}
