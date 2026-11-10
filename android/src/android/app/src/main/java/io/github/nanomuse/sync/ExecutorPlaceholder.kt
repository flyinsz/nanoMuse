package io.github.nanomuse.sync

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import com.openminis.app.R
import io.github.nanomuse.hub.Hub

/**
 * The composer's line for a synced conversation: the device the next turn runs on (executor
 * handoff v2, `docs/tasks/executor-handoff-v2.md` §4.2).
 *
 * `@飞牛深圳` for a chat whose context lives on the NAS; `@本机` for this phone's own. Empty when
 * there is nothing to say — signed out, or a chat the relay never synced — and the composer then
 * keeps upstream's own line. The executor is *state* (where the next sentence runs), so once the
 * account is live it holds the line whatever the rotation index; it is not a hint to rotate away.
 *
 * Reactive on [ConversationSync.owners]: a pull that moves the owner changes the line without the
 * composer knowing anything about sync.
 */
@Composable
internal fun rememberExecutorPlaceholder(sessionId: String): String {
    val owners by ConversationSync.owners.collectAsState()
    val context = LocalContext.current
    // Nothing to name until sync has run: a signed-out phone, or a chat that has never been
    // pushed. Empty hands the line back to the composer, which is what upstream drew.
    if (owners.isEmpty()) return ""
    val selfLabel = stringResource(R.string.nm_executor_self)
    val owner = owners[sessionId]
    return DeviceOwner.placeholder(
        target = DeviceOwner.resolve(owner?.id.orEmpty(), owner?.name.orEmpty(), Hub.deviceId(context)),
        selfLabel = selfLabel,
        // the device's own name into `@%1$s`, through the resource so every locale formats it
        deviceFormat = { name -> context.getString(R.string.nm_executor_device, name) },
    )
}
