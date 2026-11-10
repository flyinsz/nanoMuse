package io.github.nanomuse.sync

import com.openminis.app.data.FileMentionIndex
import io.github.nanomuse.hub.Device

/**
 * The `@` menu of the composer (executor handoff v2, `docs/tasks/executor-handoff-v2.md` §7.2).
 *
 * Upstream's `@` lists files, skills and memories out of [FileMentionIndex]. This adds the
 * account's *devices* on top, and this phone itself as a fixed first row — so one menu both
 * addresses a device and mentions a file, and `@本机` (the word that takes the next turn back
 * here) is something the person can pick rather than having to remember.
 *
 * The devices arrive as [FileMentionIndex.Entry] rows too, so the composer's existing picker
 * draws them without knowing about the hub; [FileMentionIndex.Entry.nmDevice] marks them, and
 * `nmSelf` marks the this-phone row (which has no hub entry — the hub never lists the device
 * that is asking).
 *
 * Only a mention at the very start of the line takes over the menu: upstream's file picker
 * opens anywhere in the text, and stealing that would break "see @foo.txt" mid-sentence. When
 * the anchor is not a leading `@`, the file list is returned untouched.
 */
object DeviceMentionMenu {

    /**
     * @param text     the composer's whole content
     * @param anchor   the caret index of the `@` being typed (-1 when none)
     * @param filter   what has been typed after the `@`
     * @param devices  the account's *other* devices (this phone is added here, not expected in it)
     * @param files    the file/skill/memory matches, upstream's own list
     * @param selfName this phone's own label for the row that takes the turn back here
     */
    fun entries(
        text: String,
        anchor: Int,
        filter: String,
        devices: List<Device>,
        files: List<FileMentionIndex.Entry>,
        selfName: String = "",
    ): List<FileMentionIndex.Entry> {
        if (anchor !in text.indices || text[anchor] !in listOf('@', '＠') || text.substring(0, anchor).isNotBlank()) return files
        val named = devices.filter { it.kind != "web" && it.name.isNotBlank() }
        // this phone first, so `@本机` is always one keystroke away (§7.2 rule 3): it is the
        // way back from a handoff, and it must not depend on the account listing this device
        // (it never does) or on the filter matching its own name
        val self = if (selfName.isNotBlank() && filter.isBlank()) {
            listOf(
                FileMentionIndex.Entry(
                    linuxPath = selfName,
                    scope = FileMentionIndex.Scope.MOUNT,
                    mountName = null,
                    modifiedAt = Long.MAX_VALUE,
                    isDirectory = false,
                    nmSelf = true,
                )
            )
        } else {
            emptyList()
        }
        val rows = named.filter { it.online && "task" in it.actions && it.name.contains(filter, ignoreCase = true) }
            .sortedWith(compareBy<Device> { !it.name.startsWith(filter, ignoreCase = true) }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name }.thenBy { it.id })
            .map { device ->
                val duplicate = named.count { it.name.equals(device.name, ignoreCase = true) } > 1
                FileMentionIndex.Entry(
                    linuxPath = if (duplicate) "${device.name} [${device.id}]" else device.name,
                    scope = FileMentionIndex.Scope.MOUNT,
                    mountName = null,
                    modifiedAt = device.lastSeen,
                    isDirectory = false,
                    nmDevice = device,
                )
            }
        return (self + rows + files).take(50)
    }
}
