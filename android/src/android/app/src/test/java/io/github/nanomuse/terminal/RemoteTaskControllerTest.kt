package io.github.nanomuse.terminal

import io.github.nanomuse.reach.Computers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * The card a question from another device is answered on carries an id built from that
 * device's hub id and the target's own `approval_id`. It has to be namespaced for two
 * reasons, and both have bitten this kind of code before:
 *
 *  - the same phone shows other cards (its own shell's, a computer's pushed scheduled
 *    question). Those use their own ids; a task's question must not be able to collide
 *    with one and pull down the wrong card when it is withdrawn.
 *  - two devices of the account may hand out the same `approval_id` (a runtime counts its
 *    own approvals from a sequence). Keyed on the target's id alone, a `approval_result`
 *    from one device would take down a card waiting on another.
 */
class RemoteTaskControllerTest {
    private fun device(hubId: String, name: String = "Mac mini") =
        Computers.Computer(id = "hub:$hubId", name = name, os = "macos", hubId = hubId)

    @Test
    fun a_card_is_namespaced_by_the_device_that_asked() {
        assertEquals("task|mac-1|ap-7", RemoteTaskController.cardId(device("mac-1"), "ap-7"))
    }

    @Test
    fun the_same_approval_id_on_two_devices_is_two_cards() {
        val here = RemoteTaskController.cardId(device("mac-1"), "ap-7")
        val there = RemoteTaskController.cardId(device("pixel-2", "Pixel 8"), "ap-7")
        assertNotEquals(here, there)
    }

    @Test
    fun two_questions_from_one_device_are_two_cards() {
        assertNotEquals(
            RemoteTaskController.cardId(device("mac-1"), "ap-7"),
            RemoteTaskController.cardId(device("mac-1"), "ap-8"),
        )
    }

    @Test
    fun the_id_says_which_path_raised_the_card() {
        // the other cards on this phone: a computer's pushed question (ComputerCards) and
        // the shell's own. A task's question is prefixed so a broad withdraw cannot reach them.
        val card = RemoteTaskController.cardId(device("mac-1"), "ap-7")
        assertEquals(true, card.startsWith("task|"))
    }
}
