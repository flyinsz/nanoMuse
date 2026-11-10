"""Attachments across devices (``nanomuse/sync/files.py``): the reference a file travels
as, the name rules on the way to disk, and the upload/download around a relay.

The relay is a stand-in throughout — a small object with the three blob methods and a
record of what was asked of it, so nothing here touches the network. The names and the
collision rule are the interesting part: a reference arrives from another device, and it
must not be able to write outside the directory it is given, or over a file already there.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from nanomuse.cloud import CloudError

# nanomuse.server first: the runtime's sync engine imports nanomuse.server.events, and
# nanomuse.server.service imports nanomuse.sync — importing the sync package first hits the
# half-built one (the same order tests/test_sync.py and tests/test_owner_routing.py use)
from nanomuse.server import create_app  # noqa: F401
from nanomuse.sync.files import (
    MAX_BLOB_BYTES,
    download,
    file_ref,
    free_path,
    refs_of,
    safe_name,
    upload,
)


class FakeCloud:
    """The three blob methods, and a log of the calls that reached them."""

    def __init__(
        self, has: bool = False, body: bytes | None = None, fail: CloudError | None = None
    ):
        self._has = has
        self._body = body
        self._fail = fail
        self.has_calls: list[str] = []
        self.put_calls: list[tuple[str, str, bytes]] = []
        self.get_calls: list[str] = []

    async def has_blob(self, sha256: str) -> bool:
        self.has_calls.append(sha256)
        return self._has

    async def put_blob(self, sha256: str, mime: str, data: bytes) -> dict:
        self.put_calls.append((sha256, mime, data))
        return {"sha256": sha256, "bytes": len(data), "mime": mime, "known": False}

    async def get_blob(self, sha256: str) -> bytes:
        self.get_calls.append(sha256)
        if self._fail is not None:
            raise self._fail
        if self._body is None:
            raise AssertionError("get_blob was not expected")
        return self._body


# ------------------------------------------------------------------ 1. the reference


def test_file_ref_hashes_and_names(tmp_path: Path) -> None:
    payload = "你好, nanoMuse\n".encode()
    src = tmp_path / "报告 v2.txt"
    src.write_bytes(payload)

    ref = file_ref(src)

    assert ref["sha256"] == hashlib.sha256(payload).hexdigest()
    assert ref["name"] == "报告 v2.txt"
    assert ref["mime"] == "text/plain"
    assert ref["size"] == len(payload)


def test_file_ref_name_override_is_kept(tmp_path: Path) -> None:
    """The name in the reference is the record; only ``download`` sanitises it."""
    src = tmp_path / "a.bin"
    src.write_bytes(b"x")

    ref = file_ref(src, name="../../etc/passwd")

    assert ref["name"] == "../../etc/passwd"  # kept verbatim here…
    assert ref["mime"] == "application/octet-stream"  # …an unknown type still gets one


def test_file_ref_unknown_mime_falls_back(tmp_path: Path) -> None:
    src = tmp_path / "clip.qqqunknown"
    src.write_bytes(b"z")

    assert file_ref(src)["mime"] == "application/octet-stream"


def test_refs_of_preserves_order(tmp_path: Path) -> None:
    first = tmp_path / "1.txt"
    second = tmp_path / "2.txt"
    first.write_bytes(b"one")
    second.write_bytes(b"two")

    refs = refs_of([first, second])

    assert [r["name"] for r in refs] == ["1.txt", "2.txt"]
    assert refs[0]["sha256"] != refs[1]["sha256"]


# ------------------------------------------------------------------ 2. the name rules


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        ("报告 v2.pdf", "报告 v2.pdf"),  # CJK survives
        ("写真 (1).png", "写真 (1).png"),  # spaces and round brackets are allowed
        ("a:b*c?.txt", "a_b_c_.txt"),  # each run of the rest collapses to one underscore
        ("  ...name.txt  ", "name.txt"),  # leading/trailing space, dot and underscore go
        ("../../etc/passwd", "passwd"),  # a directory part is dropped first (``Path.name``)
        ("C:\\Users\\me\\a b.txt", "C_Users_me_a b.txt"),  # a backslash is no separator here
        ("", "file"),  # nothing left → the same default save_upload uses
        ("///", "file"),
    ],
)
def test_safe_name_matches_save_upload(given: str, expected: str) -> None:
    assert safe_name(given) == expected


def test_safe_name_truncates_and_stays_one_component() -> None:
    long_name = "あ" * 300 + ".png"

    safe = safe_name(long_name)

    assert len(safe) <= 120
    assert safe == "あ" * 120
    assert "/" not in safe and Path(safe).parent == Path(".")


# ------------------------------------------------------------------ 3. collisions


def test_free_path_adds_a_suffix(tmp_path: Path) -> None:
    existing = tmp_path / "report.pdf"
    existing.write_bytes(b"first")
    (tmp_path / "report (2).pdf").write_bytes(b"second")

    target = free_path(tmp_path, "report.pdf")

    assert target.name == "report (3).pdf"
    assert not target.exists()
    assert existing.read_bytes() == b"first"  # the file already there is untouched


def test_free_path_sanitises_the_name(tmp_path: Path) -> None:
    target = free_path(tmp_path, "../../evil.sh")

    assert target.parent == tmp_path
    assert target.name == "evil.sh"  # the directory part is dropped, never followed


# ------------------------------------------------------------------ 4/5. upload


async def test_upload_skips_put_when_the_relay_has_it(tmp_path: Path) -> None:
    src = tmp_path / "photo.png"
    src.write_bytes(b"\x89PNG-data")
    cloud = FakeCloud(has=True)

    ref = await upload(cloud, src)  # type: ignore[arg-type]

    assert cloud.has_calls == [ref["sha256"]]
    assert cloud.put_calls == []  # the point: 32 MiB not sent for a file already up
    assert ref["name"] == "photo.png"
    assert ref["mime"] == "image/png"


async def test_upload_puts_once_when_the_relay_lacks_it(tmp_path: Path) -> None:
    payload = b"a picture, honestly"
    src = tmp_path / "photo.png"
    src.write_bytes(payload)
    cloud = FakeCloud(has=False)

    ref = await upload(cloud, src, name="trip.png")  # type: ignore[arg-type]

    assert cloud.put_calls == [(ref["sha256"], "image/png", payload)]
    assert ref["name"] == "trip.png"
    assert ref["sha256"] == hashlib.sha256(payload).hexdigest()


async def test_upload_refuses_an_empty_file(tmp_path: Path) -> None:
    src = tmp_path / "empty.txt"
    src.write_bytes(b"")
    cloud = FakeCloud()

    with pytest.raises(ValueError, match="empty"):
        await upload(cloud, src)  # type: ignore[arg-type]

    assert cloud.has_calls == [] and cloud.put_calls == []


async def test_upload_refuses_a_file_over_the_cap(tmp_path: Path) -> None:
    src = tmp_path / "big.bin"
    src.write_bytes(b"0" * 64)
    cloud = FakeCloud()

    with pytest.raises(ValueError, match="larger than"):
        await upload(cloud, src, max_bytes=32)  # type: ignore[arg-type]

    assert cloud.put_calls == []


def test_default_cap_is_the_relays() -> None:
    """The runtime's mirror of ``BLOB_MAX_BYTES``; the two move together."""
    assert MAX_BLOB_BYTES == 32 * 1024 * 1024


# ------------------------------------------------------------------ 6/7. download


async def test_download_lands_the_file_and_returns_its_path(tmp_path: Path) -> None:
    payload = b"the report, for real"
    cloud = FakeCloud(body=payload)
    dest = tmp_path / "attachments"
    ref = {
        "sha256": hashlib.sha256(payload).hexdigest(),
        "name": "季度 报告.pdf",
        "mime": "application/pdf",
        "size": len(payload),
    }

    landed = await download(cloud, ref, dest)  # type: ignore[arg-type]

    assert landed == dest / "季度 报告.pdf"
    assert landed.read_bytes() == payload
    assert cloud.get_calls == [ref["sha256"]]


async def test_download_does_not_overwrite_a_file_already_there(tmp_path: Path) -> None:
    dest = tmp_path / "attachments"
    dest.mkdir()
    (dest / "notes.txt").write_bytes(b"mine")
    cloud = FakeCloud(body=b"theirs")
    ref = {"sha256": "a" * 64, "name": "notes.txt"}

    landed = await download(cloud, ref, dest)  # type: ignore[arg-type]

    assert landed.name == "notes (2).txt"
    assert (dest / "notes.txt").read_bytes() == b"mine"
    assert landed.read_bytes() == b"theirs"


async def test_download_keeps_a_traversal_name_inside(tmp_path: Path) -> None:
    dest = tmp_path / "attachments"
    cloud = FakeCloud(body=b"payload")
    ref = {"sha256": "b" * 64, "name": "../../../etc/passwd"}

    landed = await download(cloud, ref, dest)  # type: ignore[arg-type]

    assert landed.parent == dest
    assert ".." not in landed.name


async def test_download_fails_when_the_relay_will_not_serve(tmp_path: Path) -> None:
    gone = CloudError(404, "not_found", "No such file on this account")
    cloud = FakeCloud(fail=gone)
    dest = tmp_path / "attachments"

    with pytest.raises(CloudError) as caught:
        await download(cloud, {"sha256": "c" * 64, "name": "x.txt"}, dest)  # type: ignore[arg-type]

    assert caught.value.code == "not_found"
    assert not dest.exists()  # nothing half-written


async def test_download_refuses_a_reference_without_a_hash(tmp_path: Path) -> None:
    cloud = FakeCloud(body=b"x")

    with pytest.raises(ValueError, match="sha256"):
        await download(cloud, {"name": "x.txt"}, tmp_path)  # type: ignore[arg-type]

    assert cloud.get_calls == []


# ------------------------------------------------------------------ the round trip


async def test_upload_output_is_what_download_consumes(tmp_path: Path) -> None:
    """The contract the two ends share: what ``upload`` answers is the whole of what
    ``download`` needs — the hash to fetch, the name to land under."""
    payload = "季度 报告: 涨幅 3.2%\n".encode()
    src = tmp_path / "send" / "季度 报告.csv"
    src.parent.mkdir()
    src.write_bytes(payload)
    cloud = FakeCloud(has=False)

    ref = await upload(cloud, src)  # type: ignore[arg-type]
    cloud._body = payload  # the relay now holds what was put

    landed = await download(cloud, ref, tmp_path / "recv")  # type: ignore[arg-type]

    assert landed.name == "季度 报告.csv"
    assert landed.read_bytes() == payload
    assert hashlib.sha256(landed.read_bytes()).hexdigest() == ref["sha256"]
    assert cloud.get_calls == [ref["sha256"]]
