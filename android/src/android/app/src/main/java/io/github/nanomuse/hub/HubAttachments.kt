package io.github.nanomuse.hub

import java.io.File
import java.security.MessageDigest

/**
 * The files a `task` from another device brings with it (executor handoff v2, topic B2).
 *
 * The asker puts each file on the relay by its SHA-256 (`PUT /v1/blobs/{sha256}`,
 * docs/cloud.md "The record") and names it in `args.attachments`:
 *
 *     {"sha256": "<hex>", "name": "report.pdf", "mime": "application/pdf", "size": 12345}
 *
 * `sha256` is the key the file is stored under and the only way to reach it; `name` is the
 * original file name, which the blob itself does not keep; `mime` and `size` may be absent.
 * This phone fetches them and hands them to the agent that runs the task here, so a line
 * handed over arrives with what was attached to it.
 *
 * Everything that *decides* — which entries are usable, what the file is called on disk, is
 * it a picture — is pure and lives here, apart from the Android bits. The download, the
 * folder it lands in and the `InputAttachment` it becomes are [HubAttachmentFetcher]'s.
 */
object HubAttachments {
    /**
     * A blob larger than this is not fetched. The asking device's own composer will happily
     * carry a 400 MB file (the phone streams it to disk, the agent only ever reads its path),
     * but pulling one down here is a background transfer on someone's connection for material
     * a *task* rarely needs. Past this the file is reported missing instead, which the model
     * can say out loud; the same ceiling is the relay's practical range for a request.
     */
    const val MAX_BYTES = 32L * 1024 * 1024

    /** A SHA-256 as hex; the key, so it has to be exactly that shape. */
    private val SHA256 = Regex("[0-9a-f]{64}")

    /**
     * Everything `save_upload` keeps (its rule is the account's one naming rule, and the
     * asking runtime writes the name it sends with the same one): word characters — which
     * include CJK — dots, dashes, spaces, round brackets. Anything else collapses to a single
     * `_`, and leading/trailing spaces, dots and underscores go. Separators are in that
     * "anything else", so the result is always a single path component and a name that
     * arrived from another device can never steer the write out of the folder it was handed.
     */
    private val UNSAFE = Regex("[^\\w.\\- ()\\u4e00-\\u9fff\\u3040-\\u30ff\\uac00-\\ud7af]+")

    /** One file the asking device referred to, as this phone will fetch it. */
    data class Ref(val sha256: String, val name: String, val mime: String, val size: Long)

    /**
     * One `args.attachments[]` entry as a [Ref], or null when it names no file: a `sha256`
     * that is not a hash cannot be fetched (the blob is stored by it and there is no other
     * handle), so the entry is dropped rather than guessed at.
     */
    fun ref(sha256: String, name: String, mime: String, size: Long): Ref? {
        val sha = sha256.trim().lowercase()
        if (!SHA256.matches(sha)) return null
        val clean = safeName(name, sha)
        return Ref(sha, clean, mime.trim().ifBlank { guessMime(clean) }, size)
    }

    /**
     * A file name that is safe to write in this session's attachments folder. A name that is
     * blank, hostile or nothing but dots falls back to the hash, which still says which file
     * this is. 120 characters, the same ceiling the account's other naming rule uses.
     */
    fun safeName(name: String, sha256: String): String {
        val base = name.substringAfterLast('/').substringAfterLast('\\')
            .replace(UNSAFE, "_")
            .trim(' ', '.', '_')
            .take(120)
        return base.ifBlank { "attachment-" + sha256.trim().lowercase().take(12).ifBlank { "unnamed" } }
    }

    /**
     * Whether this phone's agent should look at the file as a picture (so it goes in the
     * turn's image parts) or open it as a document (its path in the attached-files list).
     * The sender's `mime` decides; without one the extension does; a type that says nothing
     * (`application/octet-stream`, which is what an unknown extension maps to) defers to the
     * extension too, so a `.png` the asker mislabelled still arrives as a picture.
     */
    fun isImage(mime: String, name: String): Boolean {
        val m = mime.trim().lowercase()
        if (m.isEmpty() || m == "application/octet-stream") return guessMime(name).startsWith("image/")
        return m.startsWith("image/")
    }

    /** The type of a name, for a frame that did not send one. Mirrors [HubActions.mime]. */
    fun guessMime(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
        "png" -> "image/png"; "jpg", "jpeg" -> "image/jpeg"; "gif" -> "image/gif"; "webp" -> "image/webp"
        "heic", "heif" -> "image/heic"
        "pdf" -> "application/pdf"; "txt" -> "text/plain"; "md" -> "text/markdown"; "json" -> "application/json"; "csv" -> "text/csv"
        else -> "application/octet-stream"
    }

    /** A file's SHA-256, lower-case hex: the key it is stored under, checked again after the fetch. */
    fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /**
     * `<dir>/<name>`, with `(2)`, `(3)`… before the extension while that name is taken — the
     * runtime's own rule (`nanomuse/sync/files.py:free_path`), so a handoff and a runtime that
     * both receive `report.pdf` twice name the two files the same way. It creates nothing: it
     * only looks at what is already in [dir], which is why it can be checked with a scratch
     * folder and no relay.
     */
    fun freePath(dir: File, name: String): File {
        val first = File(dir, name)
        if (!first.exists()) return first
        val dot = name.lastIndexOf('.')
        val stem = if (dot > 0) name.substring(0, dot) else name
        val ext = if (dot > 0) name.substring(dot) else ""
        var n = 2
        while (true) {
            val candidate = File(dir, "$stem ($n)$ext")
            if (!candidate.exists()) return candidate
            n++
        }
    }

    /**
     * [prompt] with a line naming the files that did not come, or [prompt] itself when none
     * were missed — an older asker, or a task whose files all arrived, gives exactly the
     * prompt it always did. The line is English like the rest of the prompt's framing
     * ([HubTasks.prompt]), so the model reads it as part of the request rather than as text
     * the person wrote.
     */
    fun withMissed(prompt: String, missed: List<String>): String {
        if (missed.isEmpty()) return prompt
        return prompt + "\n\n(Attachments the other device sent could not be fetched here and are missing: ${missed.joinToString(", ")}. Say so if they matter to the answer.)"
    }
}
