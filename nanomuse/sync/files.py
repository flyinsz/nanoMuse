"""Attachments across the account's devices (contract C7, the `@<device>` handoff):
carry a file a person attached here to the device that runs the turn.

nanoMuse: a turn handed to another device used to arrive without its files — the words
reached the relay, the attachment did not (``nanomuse/server/service.py:1282`` skips the
handoff entirely when there are attachments). This is the missing half: the bytes go up the
relay's content-addressed blob channel (``PUT/HEAD/GET /v1/blobs/{sha256}``, which the
account's devices already share), and what travels in the message is only a *reference* — a
hash, a name, a type, a size. The words fit the hub's 16 MiB frame limit; the file does not,
so the file must never travel inside the message.

Layout: the reading, hashing and naming are plain functions (no ``cloud``, units-testable
on their own); :func:`upload` and :func:`download` do nothing but the I/O around them.

The name matters as much as the bytes. The relay stores a blob under its hash alone, so a
receiver that only had the hash would land the file as ``<sha256>.bin``; the reference
therefore carries the original name, and it is the receiver's only way to know what the
file was called.

**A reference is not a promise.** The relay serves a blob to an account that still holds a
``blob_refs`` row for it, and the hourly sweep (``Cloud.sweep_record``,
``cloud/nanomuse_cloud/service.py:2906``, gated on 3600 s in
``cloud/nanomuse_cloud/api.py:588``) may drop a row's whole file: ``trim_blobs`` past
``MEDIA_MAX_GB``, ``sweep_turns`` past ``RECORD_KEEP_DAYS`` when an operator sets it. Only
the avatar's clips are exempt (``owner='profile'``); the other owners — ``'turn'`` for a file
a turn names, ``'upload'`` for a bare ``PUT /v1/blobs`` such as ours — all go. With the
shipped defaults only ``trim_blobs`` ever fires (``RECORD_KEEP_DAYS=0``,
``cloud/nanomuse_cloud/config.py:469``, leaves ``sweep_turns`` switched off), and it needs
50 GiB in the store first — so a reference is durable for all practical purposes, but a
receiver must treat :class:`nanomuse.cloud.CloudError` ``not_found`` as a case that happens,
never as an impossible one.

**Fetching does not keep it alive.** ``last_used_at`` is advanced only where a reference is
written (``_reference_blob``, ``cloud/nanomuse_cloud/db.py:1773``), and reading is a pure
filesystem lookup (``MediaStore.has``/``path``, ``cloud/nanomuse_cloud/record.py:86-92``).
So a ``GET /v1/blobs`` — however often — never moves a file up the trim order; only a *new
turn* naming it does. A receiver cannot buy durability by pulling.

``RECORD_TURNS=0`` is the switch that matters most, and its meaning is **freeze, not wipe**.
A relay that boots with it off cannot take a file at all: ``put_blob`` answers 404
``not_found`` (``cloud/nanomuse_cloud/service.py:2594``), so the channel is unavailable and
the *sender* must word it — the reader's ``blob_for`` has no such check, so a receiver never
sees that particular 404. But flipping the switch off on a running relay does *not* hide
what is already stored: ``blob_for`` is pure read and still serves those hashes, and
``sweep_record`` returns early on the same flag (``cloud/nanomuse_cloud/service.py:2910``) —
so the trim stops too and the surviving files are simply never reclaimed.
"""

from __future__ import annotations

import hashlib
import mimetypes
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # the tests pass a stand-in; nothing here imports a live client
    from nanomuse.cloud import CloudClient

#: # nanoMuse: the relay's own cap on one ``PUT /v1/blobs`` (``cloud/nanomuse_cloud/config.py``,
#: ``BLOB_MAX_BYTES``, 32 MiB by default). This is a *mirror* of a value the relay owns: raise
#: it here as well when the operator raises it there, or the runtime will refuse files the
#: relay would have taken. The relay itself answers 413 ``too_large``; checking first turns
#: that into a local, wordable failure instead of a round trip.
MAX_BLOB_BYTES = 32 * 1024 * 1024

#: the longest name kept, after sanitising (``nanomuse/server/service.py:1436``)
SAFE_NAME_MAX = 120

#: # nanoMuse: the same rule as ``MuseService.save_upload`` (``nanomuse/server/service.py:1433``):
#: word characters (which include CJK), dots, dashes, spaces, round brackets, and the three
#: CJK blocks spelled out. Everything else collapses to a single ``_``, and leading/trailing
#: spaces, dots and underscores are dropped. Reimplemented here rather than imported so this
#: module stays free of the server stack — the two must be changed together.
_UNSAFE = re.compile(r"[^\w.\- ()\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+")


def safe_name(name: str) -> str:
    """A file name that is safe to write into a directory: ``save_upload``'s rule, nothing more.

    # nanoMuse: mirrors ``nanomuse/server/service.py:1433-1436``. Any separator is gone with
    the rest of the punctuation, so the result is always a single path component — a
    reference that arrived from another device (or that a person typed) can never steer the
    write out of the directory it was handed.
    """
    safe = _UNSAFE.sub("_", Path(name).name).strip(" ._")
    return safe[:SAFE_NAME_MAX] or "file"


def free_path(folder: Path, name: str) -> Path:
    """``folder/<safe name>``, with ``"(2)"``, ``"(3)"``… added while that name is taken.

    # nanoMuse: ``save_upload``'s suffix loop
    # (``nanomuse/server/service.py:1440-1444``), so a second file
    called ``report.pdf`` lands beside the first instead of over it — a handoff must never
    destroy the file it was named after. Does not create anything, which is what makes the
    collision rule testable without a relay.
    """
    target = folder / safe_name(name)
    stem, suffix = target.stem, target.suffix
    n = 2
    while target.exists():
        target = folder / f"{stem} ({n}){suffix}"
        n += 1
    return target


def _ref(path: Path, name: str, data: bytes) -> dict[str, Any]:
    shown = name or path.name
    return {
        "sha256": hashlib.sha256(data).hexdigest(),
        # the relay keys a blob by its hash, so the name is not recoverable from the store:
        # it travels in the reference or the file arrives nameless
        "name": shown,
        # ``guess_type`` answers None for a name it does not know; ``blob_for`` defaults a
        # stored type the same way (``cloud/nanomuse_cloud/service.py:2653``), and an empty
        # Content-Type would be worse than a generic one
        "mime": mimetypes.guess_type(shown)[0] or "application/octet-stream",
        # what was hashed, not a second ``stat``: if the file changed in between, the size
        # must describe the bytes we are vouching for
        "size": len(data),
    }


def file_ref(path: Path, name: str = "") -> dict[str, Any]:
    """The reference this file will travel as: ``{sha256, name, mime, size}``.

    # nanoMuse: reads the whole file to hash it. That is the price of content addressing —
    a file already on the relay is recognised without a new upload (see :func:`upload`).

    ``name`` overrides what the receiver will call the file; it defaults to ``path.name``
    and is kept as given here (the *reference* is a record — :func:`download` sanitises on
    the way to disk, where sanitising is what protects the directory).
    """
    return _ref(path, name, path.read_bytes())


def refs_of(paths: list[Path]) -> list[dict[str, Any]]:
    """One reference per path, in order — the ``attachments`` a handoff message carries.

    # nanoMuse: ``attachments`` is the hub frame's key; the local timeline's own
    ``files`` (``nanomuse/server/service.py:1253``) is a different thing and stays as it is.
    """
    return [file_ref(path) for path in paths]


async def upload(
    cloud: CloudClient,
    path: Path,
    name: str = "",
    max_bytes: int = MAX_BLOB_BYTES,
) -> dict[str, Any]:
    """Put a local file on the relay and answer its reference.

    ``max_bytes`` caps one file; it defaults to the relay's own ``BLOB_MAX_BYTES``
    (:data:`MAX_BLOB_BYTES`) — **change it with the relay's setting**, not instead of it.

    # nanoMuse: fails outright on an empty file or one past the cap (``ValueError``) rather
    than sending a truncated body: the relay would reject both anyway (400 and 413), and a
    silently short file that hashes to the right name is worse than a clear no. A file the
    relay already holds is *not* sent again — ``has_blob`` first, so a picture that came
    back around to this device costs one HEAD instead of 32 MiB.

    Every type is forwarded here (this is plan B2: a ``.pdf``, a ``.csv``, a ``.txt``
    travels like a picture), and the relay was widened to match — ``BLOB_MIMES`` now takes
    ``image/``, ``audio/``, ``video/``, ``application/`` and ``text/``. Two kinds of file
    still fall outside it: a type that is none of those five and *is* known to
    ``mimetypes`` (``font/woff2``, ``model/gltf+json``), which the relay answers 400; and
    anything unnamed, which :func:`file_ref` types as ``application/octet-stream`` and so
    does go through. The gate is the relay's to widen further — the runtime does not
    re-decide which files a person may attach.
    """
    data = path.read_bytes()
    if not data:
        raise ValueError(f"{path} is empty; the relay does not store empty files")
    if len(data) > max_bytes:
        raise ValueError(
            f"{path} ({len(data)} bytes) is larger than the relay takes ({max_bytes} bytes)"
        )
    ref = _ref(path, name, data)
    if await cloud.has_blob(ref["sha256"]):
        return ref
    await cloud.put_blob(ref["sha256"], ref["mime"], data)
    return ref


async def download(cloud: CloudClient, ref: dict[str, Any], dest_dir: Path) -> Path:
    """Fetch the file a reference names into ``dest_dir``; the path it landed on.

    # nanoMuse: the receiver's whole job. The name is sanitised and a taken one gets a
    suffix (:func:`free_path`), so nothing is overwritten and the write stays inside
    ``dest_dir`` — that is ``attachments/<date>`` of the workspace, whose own resolution
    rules the caller owns. A relay that will not serve the blob raises
    :class:`nanomuse.cloud.CloudError` (``not_found``); it is not swallowed into an empty
    file, and :meth:`~nanomuse.cloud.CloudClient.get_blob` refuses an empty body too.

    That ``not_found`` is a **real** outcome, not a bug — a reference may have been
    trimmed since it was written, and fetching does not protect it (see the module
    docstring). The caller words it for the person; the file is simply gone.
    """
    sha = str(ref.get("sha256") or "")
    if not sha:
        raise ValueError("a file reference without a sha256 names nothing to fetch")
    data = await cloud.get_blob(sha)
    if not data:
        raise ValueError(f"the relay served an empty file for {sha}")
    dest_dir.mkdir(parents=True, exist_ok=True)
    target = free_path(dest_dir, str(ref.get("name") or sha))
    target.write_bytes(data)
    return target
