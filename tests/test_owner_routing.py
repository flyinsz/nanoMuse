"""nanoMuse: who runs a line (the owner rule and its `@` overrides), and the two halves of
live streaming — the runtime's own runs going up to the relay, and the other devices' runs
arriving here. All pure or in-memory: no relay, no hub, no network."""

from __future__ import annotations

import asyncio
from typing import Any

# nanomuse.server first: the runtime's sync engine imports nanomuse.server.events, and
# nanomuse.server.service imports nanomuse.sync — importing the sync package first hits the
# half-built one (the same order tests/test_sync.py uses avoids this)
from nanomuse.server import create_app  # noqa: F401
from nanomuse.sync.mention import parse_mention
from nanomuse.sync.owner import Route, Where, online, resolve, should_mark_owner

DEVICES = [
    {"id": "phone-1", "name": "Pixel 8", "kind": "phone", "online": True},
    {"id": "mac-1", "name": "Mac mini", "kind": "computer", "online": False},
    {"id": "mac-2", "name": "MacBook", "kind": "computer", "online": True},
]
SELF = "nas-1"
SELF_NAME = "飞牛深圳"


# ----------------------------------------------------------------------------- owner routing
def test_a_plain_line_runs_on_the_owner() -> None:
    """The default is the conversation's owner, not this device: a chat synced in from the
    nas keeps running there, and a line in a chat this device owns runs here."""
    r = resolve("帮我看下日志", DEVICES, SELF, SELF_NAME, owner_id="mac-2")
    assert r.where is Where.HANDOFF and r.device_id == "mac-2" and r.text == "帮我看下日志"
    r = resolve("你好", DEVICES, SELF, SELF_NAME, owner_id=SELF)
    assert r.where is Where.RUN_HERE and r.device_id == SELF
    # nobody has run it yet: it begins here
    r = resolve("你好", DEVICES, SELF, SELF_NAME, owner_id="")
    assert r.where is Where.RUN_HERE


def test_a_mention_beats_the_owner() -> None:
    """`@<device>` hands the line there whatever the owner is; `@本机` and this device's own
    name take it back from an owner elsewhere."""
    r = resolve("@Pixel 8 截图", DEVICES, SELF, SELF_NAME, owner_id="mac-2")
    assert r.where is Where.HANDOFF and r.device_id == "phone-1" and r.text == "截图"
    r = resolve("@本机 你自己来", DEVICES, SELF, SELF_NAME, owner_id="mac-2")
    assert r.where is Where.RUN_HERE and r.device_id == SELF and r.text == "你自己来"
    r = resolve(f"@{SELF_NAME} 你自己来", DEVICES, SELF, SELF_NAME, owner_id="mac-2")
    assert r.where is Where.RUN_HERE and r.device_id == SELF


def test_an_offline_target_is_refused_not_run_here() -> None:
    """An offline owner (or an offline named device) does not swallow the line, and it is not
    silently run here where the model has none of that conversation's context: it is refused
    with a reason the caller shows."""
    r = resolve("继续", DEVICES, SELF, SELF_NAME, owner_id="mac-1")
    assert r.where is Where.UNROUTABLE and r.device_id == "mac-1" and r.reason == "owner_offline"
    r = resolve("@Mac mini 继续", DEVICES, SELF, SELF_NAME, owner_id=SELF)
    assert r.where is Where.UNROUTABLE and r.reason == "offline"
    # a device the hub does not list reads as offline
    assert not online(DEVICES, "ghost") and online(DEVICES, "phone-1")


def test_mark_owner_follows_running_here() -> None:
    assert should_mark_owner(Route(Where.RUN_HERE, "x"))
    assert not should_mark_owner(Route(Where.HANDOFF, "x", device_id="mac-2"))


def test_mention_of_an_unknown_name_is_an_ordinary_message() -> None:
    assert parse_mention("@nobody hi", DEVICES, SELF, SELF_NAME) is None


def test_the_two_self_words_the_clients_show_both_work() -> None:
    """The composer's placeholder is `@本机` in 简体中文 and `@This device` in English; typing
    either must take the turn back, or the placeholder promises something the send cannot do.
    The list is deliberately these two and no more (the clients' parsing matches it)."""
    from nanomuse.sync.mention import SELF_WORDS

    assert set(SELF_WORDS) == {"本机", "this device"}
    for word in ("本机", "this device", "This device", "THIS DEVICE"):
        r = resolve(f"@{word} 你来", DEVICES, SELF, SELF_NAME, owner_id="mac-2")
        assert r.where is Where.RUN_HERE, word
        assert r.text == "你来", word
    # a word that only starts like the self word is not this device
    assert parse_mention("@This devices hi", DEVICES, SELF, SELF_NAME) is None
    assert parse_mention("@本机子 hi", DEVICES, SELF, SELF_NAME) is None


# ----------------------------------------------------------------------------- stream sender
class _FakeCloud:
    def __init__(self) -> None:
        self.api_key = ""
        self.batches: list[dict[str, Any]] = []

    async def _request(self, method: str, path: str, body: Any = None) -> Any:
        if path == "/v1/sync/stream":
            self.batches.append(body)
            return None
        return {}


class _FakeClient:
    def __init__(self) -> None:
        self.cloud = _FakeCloud()

    async def stream(self, body: dict[str, Any]) -> None:
        self.cloud.batches.append(body)


class _FakeHub:
    device_id = SELF

    def _key(self) -> str:
        return "k"


class _FakeThread:
    def __init__(self, tid: str, cid: str) -> None:
        self.id = tid
        self._cid = cid


class _FakeSync:
    """The bits of ConversationSync the sender reads: active, _eligible, cid_of, svc."""

    def __init__(self, threads: dict[str, Any]) -> None:
        self.svc = type("Svc", (), {"threads": threads, "hub": _FakeHub()})()
        self.client = _FakeClient()
        self.active = True
        self._stopped = False

    def _eligible(self, thread: Any) -> bool:
        return True

    def cid_of(self, tid: str) -> str | None:
        t = self.svc.threads.get(tid)
        return t._cid if t is not None else None


def test_the_sender_batches_deltas_and_sends_done() -> None:
    """Pieces of one run are batched (not one frame a token), the batch carries the run's
    round, and a `done` closes it. `_flush` is driven by hand, so no timing is needed."""

    async def main() -> None:
        from nanomuse.sync.stream import StreamSender

        threads = {"t1": _FakeThread("t1", "cid-1")}
        sync = _FakeSync(threads)
        sender = StreamSender(sync)  # type: ignore[arg-type]
        sender.on_frame({"kind": "stream_start", "thread": "t1", "id": "a_1"})
        for piece in ("你", "好", "，"):
            sender.on_frame({"kind": "delta", "thread": "t1", "id": "a_1", "text": piece})
        sender.on_frame({"kind": "reasoning_delta", "thread": "t1", "id": "a_1", "text": "想"})
        # one flush sends one batch with all the pieces joined, and no timing was waited
        batch = sender._pending["t1"]
        await sender._post(batch)
        out = sync.client.cloud.batches[0]
        assert out["delta"] == "你好，" and out["reasoning"] == "想"
        assert out["cid"] == "cid-1" and out["device"] == SELF and out["round"].startswith("r-")
        assert out["done"] is False
        # the queue was drained by that batch, so a second with nothing new sends nothing
        sender.on_frame({"kind": "stream_end", "thread": "t1", "id": "a_1"})
        await sender._post(sender._pending["t1"])
        done = sync.client.cloud.batches[-1]
        assert done["done"] is True and "delta" not in done

    asyncio.run(main())


def test_the_sender_holds_back_a_thread_this_device_does_not_sync() -> None:
    """A thread that is not this device's to sync (a chat addressed to another device, or the
    wrong account) is never posted, even with a live run on the bus."""

    async def main() -> None:
        from nanomuse.sync.stream import StreamSender

        threads = {"t1": _FakeThread("t1", "cid-1")}
        sync = _FakeSync(threads)
        sync._eligible = lambda thread: False  # type: ignore[method-assign]
        sender = StreamSender(sync)  # type: ignore[arg-type]
        sender.on_frame({"kind": "stream_start", "thread": "t1", "id": "a_1"})
        sender.on_frame({"kind": "delta", "thread": "t1", "id": "a_1", "text": "x"})
        assert not sender._pending
        assert not sync.client.cloud.batches

    asyncio.run(main())
