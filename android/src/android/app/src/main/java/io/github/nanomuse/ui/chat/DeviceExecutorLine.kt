package io.github.nanomuse.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openminis.app.R
import io.github.nanomuse.reach.Computers
import io.github.nanomuse.terminal.DeviceExecutor

/**
 * One quiet line over the device strip saying which device runs what is typed in this chat
 * (contract C13, `docs/session-handoff.md` §2 "界面必须常显当前 owner").
 *
 * Why here and not inside the chat. The strip above the box is already the account's Muses, and
 * the face drawn large is the one this chat is aimed at — so the line is the same fact in words,
 * beside the thing it explains. The Mac client draws the same line above its composer and the Web
 * console draws it inside the conversation; the wording is shared, which is why the three strings
 * say what the desktop's own `ExecutorLine` says.
 *
 * The resolution is [DeviceExecutor.of], which the send takes too, so the line and the destination
 * cannot drift apart — a line naming one device while the words went to another is worse than no
 * line. [aimedHubId] is the chat's aim as the strip draws it ([DeviceAim]): blank for this phone's
 * own chat, a hub id otherwise. [muses] is the account's Muses as `DeviceStrip.muses` lists them,
 * this phone included — the same list the strip draws, so the two agree about who is who.
 *
 * A device that is asleep is still named, with the send's own refusal in the wording — that is the
 * state a person most needs to see before typing, not after ([DeviceExecutor.Target.Device.online]
 * is the relay's word, and the send that refuses an offline target answers the same sentence).
 *
 * Nothing is drawn when the account has no other device ([DeviceExecutor.visible]): "Run by this
 * device" in every chat would say the same thing in all of them and so say nothing.
 */
@Composable
fun nmDeviceExecutorLine(
    aimedHubId: String,
    muses: List<Computers.Computer>,
    modifier: Modifier = Modifier,
) {
    val target = remember(aimedHubId, muses) { DeviceExecutor.of(aimedHubId, muses) }
    if (!DeviceExecutor.visible(target, muses)) return
    val owner = (target as? DeviceExecutor.Target.Device)?.let { t -> muses.firstOrNull { it.hubId == t.id } }
    val label = when (target) {
        is DeviceExecutor.Target.Local -> stringResource(R.string.nm_device_executor_self)
        is DeviceExecutor.Target.Device ->
            if (target.online) stringResource(R.string.nm_device_executor, target.name)
            else stringResource(R.string.nm_device_executor_offline, target.name)
    }
    Row(
        modifier = modifier.fillMaxWidth().padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // The device's own kind, so the line reads at a glance without its words: the same pairing
        // the strip's discs use (DeviceFacesRow draws a phone or a computer by `kind`).
        Icon(
            imageVector = if (owner?.kind == "phone") Icons.Default.PhoneAndroid else Icons.Default.Computer,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(13.dp),
        )
        Text(
            text = label,
            fontSize = 11.sp,
            lineHeight = 13.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 5.dp),
        )
    }
}
