"""The stream sender must never repost another device's run.

A turn running on another device reaches this one as bus frames carrying ``remote``
(``engine._apply_stream`` publishes exactly that: ``stream_start`` / ``delta`` /
``reasoning_delta`` / ``tool_delta`` / ``stream_end``, each with ``"remote": True``, so every
client here renders a run happening elsewhere the way it renders its own). The watch loop
feeds *every* bus frame to ``StreamSender.on_frame``, so without a gate the sender treated
those remote frames as its own run and posted them back up to the relay — which fanned them
out again, to the first device as well, which posted them again. Three devices and one run
became an unbounded loop of frames: the reported "three-terminal window jumping".

These two tests pin both directions: a remote frame is dropped, a local one still goes.
"""

from __future__ import annotations

import asyncio

import pytest

from nanomuse.server import create_app  # noqa: F401  (建立正确的导入顺序)
from nanomuse.sync.stream import StreamSender


class _Thread:
    id = "main"


class _Cloud:
    def __init__(self):
        self.batches = []
        self.api_key = ""

    async def _request(self, m, p, b=None):
        if p == "/v1/sync/stream":
            self.batches.append(b)


class _Client:
    def __init__(self):
        self.cloud = _Cloud()

    async def stream(self, body):
        await self.cloud._request("POST", "/v1/sync/stream", body)


class _Hub:
    device_id = "nas-1"

    def _key(self):
        return "k"


class _Svc:
    def __init__(self):
        self.threads = {"main": _Thread()}
        self.hub = _Hub()


class _Sync:
    def __init__(self):
        self.svc = _Svc()
        self.active = True
        self._stopped = False
        self.client = _Client()

    def _eligible(self, t):
        return True

    def cid_of(self, tid):
        return "cid-1"


@pytest.mark.asyncio
async def test_remote_frame_is_not_reposted():
    """nanoMuse: 别的设备跑的流帧（remote=True，由 _apply_stream 发布到本机 bus）绝不能被本机重推，
    否则两端互相喂帧形成无限回环。"""
    s = _Sync()
    sender = StreamSender(s)
    sender.on_frame({"kind": "stream_start", "thread": "main", "id": "r1:pc-x", "remote": True})
    sender.on_frame(
        {"kind": "delta", "thread": "main", "id": "r1:pc-x", "text": "远端", "remote": True}
    )
    await asyncio.sleep(0.5)
    assert s.client.cloud.batches == [], (
        f"回环重推 {len(s.client.cloud.batches)} 批: {s.client.cloud.batches}"
    )


@pytest.mark.asyncio
async def test_local_frame_is_still_posted():
    """反向保护：不带 remote 的本机帧仍然要照常上行（别把功能修没了）。"""
    s = _Sync()
    sender = StreamSender(s)
    sender.on_frame({"kind": "stream_start", "thread": "main"})
    sender.on_frame({"kind": "delta", "thread": "main", "text": "本机的字"})
    await asyncio.sleep(0.5)
    assert len(s.client.cloud.batches) == 1, s.client.cloud.batches
    assert s.client.cloud.batches[0]["delta"] == "本机的字"
