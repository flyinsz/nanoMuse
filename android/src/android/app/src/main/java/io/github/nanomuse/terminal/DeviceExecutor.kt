package io.github.nanomuse.terminal

import io.github.nanomuse.reach.Computers

/**
 * Which device runs what is typed in a chat, as the line above the device strip reads it
 * (contract C13, `docs/session-handoff.md` §2 "界面必须常显当前 owner").
 *
 * Why a line at all. `@<device>` moves the device a chat belongs to and the choice sticks, and
 * nothing else on screen changes when it does — so without a line the person cannot tell whether
 * the next sentence runs here or on the desk machine. The Mac client draws the same line above its
 * composer (`harness/dsh-nanomuse/src/client/ExecutorLine.tsx`) and the Web console draws it inside
 * the conversation; the wording here matches theirs.
 *
 * The same resolution the send takes. A message with no `@` goes where the chat is aimed
 * ([DeviceAim]), and a blank aim is this phone — which is what [of] answers, so the line and the
 * destination cannot drift apart the way two copies of a rule do. Ownership is read from the aim
 * alone, never from where the last synced turn came from: a turn that arrived from another device
 * says nothing about which device holds the context, and reading it off there would hand the next
 * sentence to whoever spoke last.
 *
 * A device that went offline stays named rather than falling back to this phone: that is the case
 * the person most needs to see before typing, and the send refuses with its name in the wording
 * ([RemoteTaskController.Outcome.Offline]).
 */
object DeviceExecutor {
    /** Where what is typed runs: this phone, or one of the account's other devices. */
    sealed interface Target {
        /** This phone's own Muse — the main chat's Muse, and the answer for a blank or stale aim. */
        data object Local : Target

        /** [name] is the account's name for the device; [online] is the relay's last word on it. */
        data class Device(val id: String, val name: String, val online: Boolean) : Target
    }

    /**
     * Who runs this chat, from the aim the strip draws ([aimedHubId], `DeviceAim.id` — blank when
     * the chat is this phone's own) and the account's Muses as [DeviceStrip.muses] lists them
     * (this phone included, browser tabs and nameless entries already left out).
     *
     * A blank aim, an aim at this phone, and an aim at a device the account no longer lists are all
     * [Target.Local]: there is nobody else to hand the sentence to, and the ordinary path is the
     * phone's own Muse. That last one is the same fallback the strip makes when an aim goes stale
     * ([DeviceStrip.focusIndex]).
     */
    fun of(aimedHubId: String, muses: List<Computers.Computer>): Target {
        val wanted = aimedHubId.trim()
        if (wanted.isEmpty()) return Target.Local
        val device = muses.firstOrNull { it.hubId == wanted } ?: return Target.Local
        if (device.isThis) return Target.Local
        return Target.Device(id = device.hubId, name = device.name, online = device.online)
    }

    /**
     * Whether the line is worth drawing at all. A device owner always is — a person has to know the
     * sentence leaves this phone, and an offline one most of all. "Run by this device" on an
     * account with no other device would say the same thing in every chat and so say nothing, so
     * it is hidden there; the Mac client draws the same distinction (`executorVisible`).
     */
    fun visible(target: Target, muses: List<Computers.Computer>): Boolean = when (target) {
        is Target.Device -> true
        is Target.Local -> others(muses).isNotEmpty()
    }

    /**
     * The devices that could be an owner: another device of the account, with a name. Browser tabs
     * cannot — there is nothing there to run a sentence on.
     */
    private fun others(muses: List<Computers.Computer>): List<Computers.Computer> =
        muses.filter { !it.isThis && it.kind != "web" && it.name.isNotBlank() }
}
