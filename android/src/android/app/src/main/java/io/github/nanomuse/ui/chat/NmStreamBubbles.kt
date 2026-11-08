package io.github.nanomuse.ui.chat

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openminis.app.ui.markdown.MarkdownText
import io.github.nanomuse.sync.ConversationSync
import io.github.nanomuse.sync.StreamBuckets

/**
 * A turn running on another device of the account, drawn in the chat as it goes (contract C13, §4).
 *
 * [NmWorkingLine] says, in one line, that another device is on this chat; this draws the turn
 * itself: the words as they are written, in the harness's own Markdown shape, with each step where
 * it happened rather than every step piled up after the last paragraph. A turn reads, calls a tool,
 * says what it found, calls another, and the bubble keeps that order.
 *
 * One bubble per round, so two turns in one chat stand apart rather than writing over each other.
 * Like [NmWorkingLine] it follows the account's own state: nothing is drawn for a chat this phone
 * does not hold, and the bubbles go when their turn settles or goes quiet.
 */
@Composable
fun NmStreamBubbles(sessionId: String, modifier: Modifier = Modifier) {
    val buckets by ConversationSync.streams.collectAsState()
    if (buckets.isEmpty()) return
    val rounds = ConversationSync.streamsFor(sessionId)
    if (rounds.isEmpty()) return
    Column(modifier = modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
        for (round in rounds) {
            NmStreamBubble(round)
        }
    }
}

/** One round's bubble: its prose and its steps, in the order the turn wrote them. */
@Composable
private fun NmStreamBubble(bucket: StreamBuckets.StreamBucket) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val onSurface = MaterialTheme.colorScheme.onSurface
    Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        for (block in StreamBuckets.blocks(bucket)) {
            when (block) {
                is StreamBuckets.Block.Text -> MarkdownText(
                    markdown = block.markdown,
                    color = onSurface,
                    modifier = Modifier.padding(vertical = 2.dp),
                )
                is StreamBuckets.Block.Step -> NmStreamStep(
                    line = block.line,
                    bad = block.bad,
                    muted = muted,
                )
            }
        }
        // the quiet line under the words while the turn is still out: the same pulsing dot
        // [NmWorkingLine] uses, so a running turn reads as the same kind of thing
        if (!bucket.done) {
            val pulse = rememberInfiniteTransition(label = "nm-stream")
            val alpha by pulse.animateFloat(
                initialValue = 0.35f,
                targetValue = 1f,
                animationSpec = infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Reverse),
                label = "nm-stream-dot",
            )
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Spacer(Modifier.size(6.dp).alpha(alpha).background(muted, CircleShape))
            }
        }
    }
}

/**
 * One step: a quiet mark in the margin, one line, cut off rather than wrapped — the way the
 * harness's own tool rows read. It is not a paragraph of its own, and it does not push the answer
 * off the screen however long the command or its output was.
 */
@Composable
private fun NmStreamStep(line: String, bad: Boolean, muted: Color) {
    val color = if (bad) MaterialTheme.colorScheme.error else muted
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 1.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Spacer(Modifier.size(4.dp).background(color.copy(alpha = if (bad) 1f else 0.55f), CircleShape))
        Spacer(Modifier.width(6.dp))
        Text(
            text = line,
            fontSize = 12.sp,
            color = color,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
