package io.github.nanomuse.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.nanomuse.hub.Hub
import io.github.nanomuse.terminal.DeviceAim
import io.github.nanomuse.terminal.DeviceStrip

/**
 * The account's devices as a row of avatars just above the box, the one the chat is aimed at
 * drawn larger than the rest. Tapping one aims the chat at it; tapping the aimed one again lets
 * it go, so the box goes back to this phone's own Muse.
 *
 * Why a row and not only `@<device>`: the mention asks the person to know a device's name and
 * spell it, and on a phone the name is the whole cost. The row says who is reachable at a
 * glance and takes one tap, and it is also the only way to say "this chat is about that
 * machine" without repeating the name in every message ([DeviceAim] is what carries it).
 *
 * Offline devices are drawn, greyed: one that is merely asleep is still the person's, and
 * tapping it is how they find out it is not up, rather than typing a task into nothing. The
 * send then answers "not connected right now", which is a sentence they can act on.
 *
 * Nothing here changes the chat itself: no title, no model, no stored message. The aim is the
 * same kind of choice as which device a single message named, kept for the next one.
 */
@Composable
fun nmDeviceStripRow(
    sessionId: String,
    aimedId: String?,
    modifier: Modifier = Modifier,
    onAim: (io.github.nanomuse.reach.Computers.Computer?) -> Unit,
) {
    val all by Hub.devices.collectAsStateWithLifecycle()
    // the whole account, this phone and browser tabs aside: an aim at a device that is asleep
    // has to survive until it wakes
    val devices = DeviceStrip.aims(all)
    if (devices.isEmpty()) return

    Row(
        modifier = modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        for (d in devices) {
            val aimed = d.hubId == aimedId
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier
                    .widthIn(max = 64.dp)
                    .clickable { onAim(d) }
                    .padding(vertical = 2.dp),
            ) {
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .size(if (aimed) 44.dp else 34.dp)
                        .clip(CircleShape)
                        .background(
                            if (aimed) MaterialTheme.colorScheme.primary.copy(alpha = 0.12f)
                            else MaterialTheme.colorScheme.surfaceVariant,
                        )
                        .border(
                            width = if (aimed) 2.dp else 1.dp,
                            color = if (aimed) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.outlineVariant,
                            shape = CircleShape,
                        )
                        .alpha(if (d.online) 1f else 0.4f),
                ) {
                    Icon(
                        imageVector = if (d.kind == "phone") Icons.Default.PhoneAndroid else Icons.Default.Computer,
                        contentDescription = null,
                        tint = if (aimed) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(if (aimed) 20.dp else 16.dp),
                    )
                }
                Text(
                    text = d.name,
                    fontSize = if (aimed) 11.sp else 10.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    color = if (aimed) MaterialTheme.colorScheme.onSurface
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.alpha(if (d.online) 1f else 0.5f),
                )
            }
        }
    }
}
