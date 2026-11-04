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
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openminis.app.R
import io.github.nanomuse.reach.Computers

/**
 * How wide one device's slot is, whatever its disc does: the strip is laid out on fixed slots so
 * a device can grow without shifting the ones beside it. Narrow enough that a row of them still
 * reads as a row rather than as a wall: the disc is 46dp at most, and the slot only adds what the
 * name under it needs on either side.
 */
private val SLOT = 58.dp

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
    val middle = devices.indexOfFirst { it.hubId == focusedId }
    // The first composition lands where it belongs without animating: a chat that opens on a
    // device should not slide under the reader's eyes. Every pick after that rolls.
    var landed by remember { mutableStateOf(false) }
    LaunchedEffect(middle, devices.size, viewport) {
        if (viewport == 0 || middle < 0) return@LaunchedEffect
        if (landed) list.animateScrollToItem(middle) else list.scrollToItem(middle).also { landed = true }
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
            val here = d.hubId == focusedId
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
                            modifier = Modifier.size(if (here) 22.dp else 15.dp),
                        )
                    }
                }
                Text(
                    // The device being held wears the account's name for it, which is the same
                    // name every other device of the account wears, so under its own disc that
                    // name says nothing. "This device" is what the person knows it by, and it is
                    // the word the console uses for the same disc.
                    text = if (d.isThis) stringResource(R.string.nm_device_this) else d.name,
                    fontSize = if (here) 10.sp else 9.sp,
                    lineHeight = 12.sp,
                    maxLines = 2,
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
