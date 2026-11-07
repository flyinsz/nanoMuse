package io.github.nanomuse.ui.chat

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openminis.app.R
import io.github.nanomuse.reach.Computers
import io.github.nanomuse.terminal.DeviceStrip

/**
 * How wide one device's slot is, whatever its disc does: the strip is laid out on fixed slots so
 * a device can grow without shifting the ones beside it. Narrow enough that a row of them still
 * reads as a row rather than as a wall: the disc is 46dp at most, and the slot only adds what the
 * name under it needs on either side.
 */
private val SLOT = 58.dp

/**
 * The dot a device's face wears when its chat has something unread.
 *
 * The same green the app already uses for "this is up and well" (the coding list's running dot,
 * the goals' tracking tick), so a mark that means "there is something waiting for you" reads the
 * same wherever it is met. Material's own `primary` is the accent blue, which is what the *device
 * in front* is drawn in — a blue dot beside a blue ring said nothing at a glance.
 */
private val MuseNewsGreen = androidx.compose.ui.graphics.Color(0xFF34C759)

/**
 * The focused device the strip was last fitted to, or null before the first fit. Outside the
 * composition because a tap rebuilds the strip (see [nmDeviceFaces]); inside it, the flag would
 * reset on every tap and no roll would ever animate.
 */
private var nmLastFocusedDevice: String? = null

/**
 * The account's devices as a strip just above the box: one round disc per device, the one whose
 * chat is open drawn large in the middle and the rest small on either side.
 *
 * A tap on a device on the left or the right rolls the strip until that device is the middle
 * one, growing as it travels, and opens that device's chat. The roll is what makes the strip
 * read as one thing being turned rather than a row of buttons: the person watches the device
 * they picked come to the middle and become the one in front.
 *
 * The disc carries what the device *is* — a computer or a phone — rather than the agent's face:
 * the account's Muse wears one face for every device of it (the profile is per account), so the
 * face says nothing about which device a disc stands for, and a row of identical faces says
 * less than a row of what they are. The name under each disc says the rest.
 *
 * A device that is not up is drawn faint rather than hidden: it is still one of the person's,
 * and a tap says so in words instead of opening a chat that cannot answer.
 */
@Composable
fun nmDeviceFaces(
    devices: List<Computers.Computer>,
    focusedId: String,
    focusedSize: Dp,
    idleSize: Dp,
    modifier: Modifier = Modifier,
    /** hub ids whose chat has a turn under way: the disc wears the spinner */
    busyIds: Set<String> = emptySet(),
    /** hub ids whose chat holds a reply the person has not read: the disc wears a dot */
    newsIds: Set<String> = emptySet(),
    onPick: (Computers.Computer) -> Unit,
) {
    if (devices.isEmpty()) return
    val list = rememberLazyListState()
    var viewport by remember { mutableIntStateOf(0) }
    val density = LocalDensity.current
    val slotPx = with(density) { SLOT.toPx() }
    // Half a strip of padding on each end, so the first and the last device can reach the middle
    // too; with it, "scroll this device into view" is the same as "put it in the middle".
    val halfPx = ((viewport - slotPx) / 2f).coerceAtLeast(0f)
    // Which face is drawn large. A blank [focusedId] is this phone — the main chat is its own
    // chat, and its face is the one in front — so the id is resolved here rather than matched
    // against the list, where a blank would find nobody and leave every face idle.
    val middle = devices.indexOfFirst { it.hubId == focusedId }
        .takeIf { it >= 0 }
        ?: devices.indexOfFirst { it.isThis }
    // read once, outside the loop: a `stringResource` per item would read the same string again
    val newsLabel = stringResource(R.string.nm_device_has_news)
    // The first composition lands where it belongs without animating: a chat that opens on a
    // device should not slide under the reader's eyes. Every pick after that rolls.
    //
    // What was last fitted is remembered outside the composition on purpose. A tap opens another
    // chat, which rebuilds the chat screen and with it this strip; a `remember`ed flag would be
    // born false again on every tap, so every roll would be treated as a first fit and never
    // animate. It is the focused id and not the row's index: the list reorders as devices come
    // up and go down, and an index would read a reorder as a pick and roll the strip by itself.
    LaunchedEffect(middle, devices.size, viewport) {
        if (viewport == 0 || middle < 0) return@LaunchedEffect
        // The very first fit lands without animating — a chat that opens on a device should not
        // slide under the reader's eyes. Every fit after that rolls, including one that lands on
        // the device already centred: a tap should always be answered by the strip moving. The
        // console answers the same way (web/src/components/DeviceFaces.tsx), so the two do not
        // drift.
        val first = nmLastFocusedDevice == null
        nmLastFocusedDevice = focusedId
        if (first) list.scrollToItem(middle) else list.animateScrollToItem(middle)
    }

    LazyRow(
        state = list,
        modifier = modifier.fillMaxWidth().onSizeChanged { viewport = it.width },
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
        contentPadding = PaddingValues(horizontal = with(density) { halfPx.toDp() }),
    ) {
        items(devices.size, key = { devices[it].hubId }) { i ->
            val d = devices[i]
            // compared by position, because the blank focused id of the main chat means "this
            // phone" rather than "no device" — see where `middle` is resolved above
            val here = i == middle
            val grow by animateFloatAsState(
                targetValue = if (here) focusedSize.value / idleSize.value else 1f,
                animationSpec = tween(durationMillis = 280),
                label = "deviceDiscGrow",
            )
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier
                    .width(SLOT)
                    .clickable { onPick(d) }
                    .padding(vertical = 2.dp),
            ) {
                // the slot stays one size whatever the disc does, so nothing beside it moves
                Box(Modifier.size(focusedSize), contentAlignment = Alignment.Center) {
                    Box(
                        contentAlignment = Alignment.Center,
                        modifier = Modifier
                            .size(idleSize)
                            .graphicsLayer { scaleX = grow; scaleY = grow }
                            .clip(CircleShape)
                            .background(
                                if (here) MaterialTheme.colorScheme.primary.copy(alpha = 0.16f)
                                else MaterialTheme.colorScheme.surfaceVariant,
                            )
                            .border(
                                // One weight for both states, as the console draws it: what marks
                                // the device in front is the colour and the tint, not a heavier
                                // ring, which at phone density reads as a drawn-on outline.
                                width = 1.dp,
                                color = if (here) MaterialTheme.colorScheme.primary
                                else MaterialTheme.colorScheme.outlineVariant,
                                shape = CircleShape,
                            )
                            .alpha(if (d.online) 1f else 0.4f),
                    ) {
                        Icon(
                            imageVector = if (d.kind == "phone") Icons.Default.PhoneAndroid else Icons.Default.Computer,
                            contentDescription = d.name,
                            tint = if (here) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.onSurfaceVariant,
                            // 19dp inside a 40dp disc, the same proportion the console draws
                            // (22px inside 46px) — the glyph was filling its ring at 22dp
                            modifier = Modifier.size(if (here) 19.dp else 15.dp),
                        )
                    }
                    // A turn under way on that device reads here too, not just in its own chat:
                    // the strip is where the person sees who is doing what without opening each
                    // one. A dot is for news the person has not read — a reply that arrived in a
                    // chat nobody was looking at, which is the whole reason to leave one.
                    //
                    // Both sit at the disc's bottom-right corner, clear of the name under it, and
                    // the spinner wins when both would show: work under way is the more urgent of
                    // the two and the only one that clears itself. Green for the dot, which is
                    // what "something is waiting for you" already wears on the goals and in the
                    // coding list.
                    val busy = d.hubId in busyIds
                    when {
                        busy -> Box(
                            Modifier
                                .align(Alignment.BottomEnd)
                                .size(11.dp)
                                .clip(CircleShape)
                                .background(MaterialTheme.colorScheme.surface),
                            contentAlignment = Alignment.Center,
                        ) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(7.dp),
                                strokeWidth = 1.2.dp,
                                color = MaterialTheme.colorScheme.primary,
                            )
                        }
                        d.hubId in newsIds -> Box(
                            Modifier
                                .align(Alignment.BottomEnd)
                                .size(7.dp)
                                .clip(CircleShape)
                                .background(MuseNewsGreen)
                                .semantics { contentDescription = newsLabel },
                        )
                    }
                }
                Text(
                    // The device being held wears the account's name for it, which is the same
                    // name every other device of the account wears, so under its own disc that
                    // name says nothing. "This device" is what the person knows it by, and it is
                    // the word the console uses for the same disc.
                    text = if (d.isThis) stringResource(R.string.nm_device_this) else DeviceStrip.displayName(d.name),
                    fontSize = if (here) 10.sp else 9.sp,
                    lineHeight = 12.sp,
                    // One line keeps every slot the same height, so the discs stay on one level.
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center,
                    color = if (here) MaterialTheme.colorScheme.onSurface
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.alpha(if (d.online) 1f else 0.5f),
                )
            }
        }
    }
}
