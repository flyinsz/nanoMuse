package io.github.nanomuse.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The reading is `nanomuse/sync/mention.py`'s, so a message typed on this phone addresses the
 * same device a browser or an iPhone addresses with the same words. The names are plain
 * strings here: what is under test is the rule, not the hub that supplies them.
 *
 * The eighteen cases below were run against `parse_mention` itself and agree on every one.
 * The single difference is where the last check sits. `parse_mention` returns a mention whose
 * text is empty and leaves `service.py` to notice (`if mention is not None and (mention.text
 * or attachments)`); [DeviceTargetMention.reading] folds that into the reading, so a caller
 * cannot forget it and send an empty task. The outcome is the same either way: a mention with
 * nothing after it is an ordinary message.
 */
class DeviceTargetMentionTest {
    private val names = listOf("Mac mini", "MacBook Pro", "Pixel 8", "Desk")

    @Test
    fun a_whole_name_is_taken_and_the_rest_is_the_task() {
        assertEquals(
            DeviceTargetMention.Named("Pixel 8", "open the calendar"),
            DeviceTargetMention.reading("@Pixel 8 open the calendar", names),
        )
    }

    @Test
    fun the_separator_after_a_name_is_not_part_of_the_task() {
        for (mark in listOf(":", ",", "，", "：")) {
            assertEquals(
                DeviceTargetMention.Named("Desk", "build it"),
                DeviceTargetMention.reading("@Desk$mark build it", names),
            )
        }
    }

    @Test
    fun the_longest_name_wins_so_short_names_do_not_swallow_long_ones() {
        // "@Mac mini …" is the mini, not "Mac" plus "mini …": there is no device called "Mac"
        // here, but "@MacBook Pro" must not be read as a device called "Mac"
        assertEquals(
            DeviceTargetMention.Named("MacBook Pro", "run the tests"),
            DeviceTargetMention.reading("@MacBook Pro run the tests", names),
        )
        assertEquals(
            DeviceTargetMention.Named("Mac mini", "restart"),
            DeviceTargetMention.reading("@Mac mini restart", names),
        )
    }

    @Test
    fun a_name_only_counts_when_it_ends_there() {
        // "MacBook" typed when the device is "Mac mini" is not the mini: the name does not
        // end at a boundary, and no other name starts with "macbook"
        assertNull(DeviceTargetMention.reading("@MacBooks are nice", names))
    }

    @Test
    fun a_prefix_picks_the_one_name_it_starts() {
        // "pix" only starts "Pixel 8"
        assertEquals(
            DeviceTargetMention.Named("Pixel 8", "what is on screen"),
            DeviceTargetMention.reading("@pix what is on screen", names),
        )
        // "mac" starts both Macs, so nothing is guessed
        assertNull(DeviceTargetMention.reading("@mac restart", names))
    }

    @Test
    fun a_mention_and_nothing_else_is_not_a_task() {
        assertNull(DeviceTargetMention.reading("@Desk", names))
        assertNull(DeviceTargetMention.reading("@Desk  ", names))
        assertNull(DeviceTargetMention.reading("@Desk:", names))
    }

    @Test
    fun only_a_message_that_opens_with_at_is_read() {
        assertNull(DeviceTargetMention.reading("Desk build it", names))
        assertNull(DeviceTargetMention.reading("hi @Desk build it", names))
        assertNull(DeviceTargetMention.reading("@", names))
    }

    @Test
    fun an_unknown_name_is_left_to_the_ordinary_path() {
        assertNull(DeviceTargetMention.reading("@Laptop build it", names))
    }

    @Test
    fun a_name_is_matched_regardless_of_case() {
        assertEquals(
            DeviceTargetMention.Named("Desk", "build it"),
            DeviceTargetMention.reading("@desk build it", names),
        )
    }
}