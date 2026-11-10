package io.github.nanomuse.hub

import android.content.Context
import android.net.Uri
import com.openminis.app.logging.AppLogger
import com.openminis.app.ui.chat.InputAttachment
import io.github.nanomuse.cloud.NanoMuseCloud
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Fetches the files a `task` from another device brought (executor handoff v2, topic B2).
 *
 * [HubAttachments] decides *what* each reference says; this is the part that touches the
 * phone: the relay's blob route, the session's attachments folder, and the
 * [InputAttachment] the agent's turn takes. Everything a failure can do is to leave one
 * file out — see [fetchAndAdd] for why, and where the folder sits.
 */
object HubAttachmentFetcher {
    private const val TAG = "HubAttachments"

    /** What one `task` frame's `args.attachments` came to: the files, and the names that did not arrive. */
    data class Fetched(val attachments: List<InputAttachment>, val missed: List<String>)

    /**
     * The files named in [args] for the run in [sessionId].
     *
     * An older asker sends no `attachments` key and this returns ([], []) — the task then runs
     * exactly as it always did.
     *
     * A file that cannot be fetched is **left out and named in [Fetched.missed]** rather than
     * failing the task: attachments are material the asker added to a request that already says
     * what to do, and one unreadable file should not cost the person the whole run — most of
     * which has nothing to do with it. The names go into the prompt (see
     * [HubAttachments.withMissed]) so the model knows something is missing instead of quietly
     * answering around a gap.
     *
     * A missing file is an ordinary outcome, not a fault to retry: the relay keeps an account's
     * files only while its store stays under its cap (`MEDIA_MAX_GB`), evicting by *when a turn
     * last referenced* a file — and a download is not a reference, so fetching a file does not
     * keep it alive. An attachment the asker sent long ago and nothing has referenced since can
     * simply be gone. One attempt, no retry and no cache of our own.
     *
     * Each file is written to the session's own attachments folder
     * (`filesDir/minis-sessions/<sessionId>/attachments/`, the `/var/minis/attachments/` the
     * sandbox sees) and **stays there**: it is a file of this conversation now, exactly like one
     * the person attached here — the agent reaches it by shell through the turn and any later
     * turn, and the session's own deletion is what removes it. Nothing is written to a temp
     * folder to be swept later, so a file the model was told about never turns into a dead link
     * mid-run. A file that is already there under the same name and the same hash is reused
     * without a second download (handing the same file over twice costs nothing).
     */
    fun fetchAndAdd(context: Context, sessionId: String, args: JSONObject): Fetched {
        val refs = parse(args.optJSONArray("attachments"))
        if (refs.isEmpty()) return Fetched(emptyList(), emptyList())
        val dir = File(context.filesDir, "minis-sessions/$sessionId/attachments")
        val attachments = mutableListOf<InputAttachment>()
        val missed = mutableListOf<String>()
        for (ref in refs) {
            val file = try {
                fetch(context, dir, ref)
            } catch (e: Exception) {
                // No key (an older sign-in), no route on this relay, or no connection: the whole
                // batch is usually lost the same way, and each file is reported on its own line.
                AppLogger.info(TAG, "${ref.name}: not fetched, ${e.message}")
                null
            }
            if (file == null) { missed.add(ref.name); continue }
            // the name on disk, which is the sender's own unless another file already held it:
            // what the agent is told about the file has to be where the file actually is
            attachments.add(
                InputAttachment(
                    fileName = file.name,
                    uri = Uri.fromFile(file),
                    mimeType = ref.mime,
                    kind = if (HubAttachments.isImage(ref.mime, file.name)) InputAttachment.Kind.IMAGE else InputAttachment.Kind.DOCUMENT,
                ),
            )
        }
        if (missed.isNotEmpty()) AppLogger.info(TAG, "${missed.size} attachment(s) of a task could not be fetched: ${missed.joinToString(", ")}")
        return Fetched(attachments, missed)
    }

    /** The frame's entries, in order, each one as [HubAttachments.ref] reads it; an entry naming no file is dropped. */
    private fun parse(arr: JSONArray?): List<HubAttachments.Ref> {
        if (arr == null || arr.length() == 0) return emptyList()
        return (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }.mapNotNull { o ->
            HubAttachments.ref(
                sha256 = o.optString("sha256"),
                name = o.optString("name"),
                mime = o.optString("mime"),
                size = o.optLong("size", 0),
            )
        }
    }

    /**
     * The local file behind [ref], downloading it when it is not already here; null when it
     * cannot be had. The bytes are checked against [HubAttachments.Ref.sha256] before they are
     * kept — the relay stores a file by its hash, so a mismatch means the reply was not this
     * file and giving it to the agent would be worse than saying it is missing.
     */
    private fun fetch(context: Context, dir: File, ref: HubAttachments.Ref): File? {
        // the asker's own figure, before the request: a file it already knows is too big needs no transfer
        if (ref.size > HubAttachments.MAX_BYTES) {
            AppLogger.info(TAG, "${ref.name} is ${ref.size} bytes, past the ${HubAttachments.MAX_BYTES} the hub fetches")
            return null
        }
        val existing = File(dir, ref.name)
        // a file of this name from this hash is already here (the asker handed it over twice, or an
        // earlier turn fetched it): reuse it. Reading it back is bounded — anything past the
        // fetch ceiling is not a file this fetcher wrote, so it is not compared, only stepped around.
        if (existing.isFile && existing.length() <= HubAttachments.MAX_BYTES &&
            HubAttachments.sha256(existing.readBytes()) == ref.sha256
        ) {
            return existing
        }
        val got = try {
            NanoMuseCloud.getBlob(context, ref.sha256)
        } catch (e: NanoMuseCloud.CloudException) {
            AppLogger.info(TAG, "${ref.name}: the relay did not answer with the file (${e.code})")
            return null
        } ?: run {
            // A 404 here means only that this account cannot read that blob — trimmed, never
            // theirs, or a hash that names nothing. The relay's "keeps no files" refusal
            // (`RECORD_TURNS=0`) is on `PUT /v1/blobs` alone, so a reader never sees it; there
            // is nothing to tell apart, and the log states the fact rather than a guessed cause.
            AppLogger.info(TAG, "${ref.name}: the relay has no such file for this account (${ref.sha256.take(12)})")
            return null
        }
        // the type the reply carries is the one that was stored with the file; the frame's own
        // (already backfilled from the name) names it well enough for the agent
        val (_, bytes) = got
        if (bytes.size > HubAttachments.MAX_BYTES) {
            AppLogger.info(TAG, "${ref.name} came down as ${bytes.size} bytes, past the ${HubAttachments.MAX_BYTES} the hub fetches")
            return null
        }
        if (HubAttachments.sha256(bytes) != ref.sha256) {
            AppLogger.warning(TAG, "${ref.name}: the file does not match its hash")
            return null
        }
        // A name already taken by another file (the asker attached two files called `report.pdf`)
        // gets a "(2)", "(3)"… — the rule the runtime's own `free_path` uses, so the same pair of
        // files lands under the same names on both kinds of device. Reached only when the file
        // already here is a *different* file; the same file under the same name is reused above.
        val target = HubAttachments.freePath(dir, ref.name)
        dir.mkdirs()
        val tmp = File(dir, target.name + ".nanomuse-part")
        tmp.writeBytes(bytes)
        if (!tmp.renameTo(target)) { target.delete(); tmp.renameTo(target) }
        if (target.isFile) return target
        AppLogger.info(TAG, "${ref.name}: could not be written to the session")
        return null
    }
}
