package io.github.nanomuse.ui.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.nanomuse.reach.Computers
import io.github.nanomuse.ui.avatar.AgentAvatar
import io.github.nanomuse.ui.avatar.AgentMood

/**
 * The account's Muses as faces in the header: one [AgentAvatar] per device, the one whose chat
 * is open drawn large in the middle of the bar ([nmDeviceFace]) and the rest small on either
 * side of it ([nmDeviceFaces], given the halves [DeviceStrip.sides] decided).
 *
 * Every device wears the same face, and that is the account's own rule rather than a shortcut
 * here: the profile (name, avatar, emoji, colour) is one per account and every device of it
 * wears that one (nanomuse/server/service.py, `hub.profile.changed`), so a device has no face
 * of its own to draw. What tells them apart is what the person knows them by: the size — whose
 * chat is open — and the name under each face.
 *
 * A device that is not up is drawn faint rather than hidden: it is still one of the person's,
 * and a tap says so in words instead of opening a chat that cannot answer. Its mood is IDLE
 * whatever the open chat's is, nothing being under way there.
 *
 * Drawn beside the agent's own face rather than over the composer: the face is where the app
 * already says whose chat this is, and a row over the box reads as part of the message being
 * written, which it is not.
 */
@Composable
fun nmDeviceFaces(
    devices: List<Computers.Computer>,
    mood: AgentMood,
    size: Dp,
    modifier: Modifier = Modifier,
    alignEnd: Boolean = false,
    onPick: (Computers.Computer) -> Unit,
) {
    if (devices.isEmpty()) return
    Row(
        modifier = modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = if (alignEnd) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        for (d in devices) {
            nmDeviceFace(device = d, mood = mood, size = size, onClick = { onPick(d) })
        }
    }
}

/** One Muse's face and name, as the row draws them. */
@Composable
fun nmDeviceFace(
    device: Computers.Computer,
    mood: AgentMood,
    size: Dp,
    onClick: () -> Unit,
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .width(76.dp)
            .clip(RoundedCornerShape(12.dp))
            .clickable(onClick = onClick)
            .padding(vertical = 2.dp),
    ) {
        AgentAvatar(
            mood = if (device.online) mood else AgentMood.IDLE,
            size = size,
            contentDescription = device.name,
            modifier = Modifier.alpha(if (device.online) 1f else 0.35f),
            onClick = onClick,
        )
        Text(
            text = device.name,
            fontSize = 10.sp,
            lineHeight = 12.sp,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.alpha(if (device.online) 1f else 0.5f),
        )
    }
}
