"""nanoMuse: who runs a line (the owner rule and its `@` overrides), and the two halves of
live streaming — the runtime's own runs going up to the relay, and the other devices' runs
arriving here. All pure or in-memory: no relay, no hub, no network."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

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


def test_the_off_switch_puts_the_default_back_on_this_device() -> None:
    """`owner_routing` off is upstream's rule (contract C7, rule 8): with no `@`, the line
    runs here whatever the owner is — while a mention still works, `@<device>` handing off and
    `@本机` taking it back. The feature's own switch defaults on, so `resolve` with no
    `enabled` argument is the owner-routing behaviour."""
    # off: a plain line runs here even with an owner elsewhere (upstream's default)
    r = resolve("帮我看下日志", DEVICES, SELF, SELF_NAME, owner_id="mac-2", enabled=False)
    assert r.where is Where.RUN_HERE and r.device_id == SELF
    # ... and an offline owner is not refused either: the owner is simply not consulted
    r = resolve("继续", DEVICES, SELF, SELF_NAME, owner_id="mac-1", enabled=False)
    assert r.where is Where.RUN_HERE
    # a mention still moves the work, both ways
    r = resolve("@Pixel 8 截图", DEVICES, SELF, SELF_NAME, owner_id=SELF, enabled=False)
    assert r.where is Where.HANDOFF and r.device_id == "phone-1"
    r = resolve("@本机 你来", DEVICES, SELF, SELF_NAME, owner_id="mac-2", enabled=False)
    assert r.where is Where.RUN_HERE and r.device_id == SELF and r.text == "你来"
    r = resolve("@Mac mini 继续", DEVICES, SELF, SELF_NAME, owner_id=SELF, enabled=False)
    assert r.where is Where.UNROUTABLE and r.reason == "offline"
    # on (the default, and the explicit True): the owner runs it
    assert resolve("x", DEVICES, SELF, SELF_NAME, "mac-2").where is Where.HANDOFF
    assert resolve("x", DEVICES, SELF, SELF_NAME, "mac-2", enabled=True).where is Where.HANDOFF


def test_the_env_var_switch_is_read_and_defaults_on(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`NANOMUSE_OWNER_ROUTING` (plan §九): unset keeps the default (on), an explicit falsey
    value puts upstream's rule back, a truthy one turns the feature on. The config file can
    set it too — the env var has the last word."""
    from nanomuse.config import load_settings

    cfg = tmp_path / "config.toml"
    cfg.write_text("", "utf-8")
    monkeypatch.delenv("NANOMUSE_OWNER_ROUTING", raising=False)
    assert load_settings(cfg).sync.owner_routing is True
    for off in ("0", "false", "no", "off", "FALSE"):
        monkeypatch.setenv("NANOMUSE_OWNER_ROUTING", off)
        assert load_settings(cfg).sync.owner_routing is False, off
    for on in ("1", "true", "yes", "on"):
        monkeypatch.setenv("NANOMUSE_OWNER_ROUTING", on)
        assert load_settings(cfg).sync.owner_routing is True, on
    # the file's own value, when the environment says nothing
    cfg.write_text("[sync]\nowner_routing = false\n", "utf-8")
    monkeypatch.delenv("NANOMUSE_OWNER_ROUTING", raising=False)
    assert load_settings(cfg).sync.owner_routing is False


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


# ----------------------------------------------------------------------------- pull adopts owner
class _Relay:
    """The relay's /v1/sync/* as the engine reads them: one canned page of conversations, the
    pushes recorded for inspection. Enough for the owner-adoption paths (C7/C8)."""

    def __init__(self) -> None:
        self.cloud = type("C", (), {"api_key": ""})()
        self.convs: list[dict[str, Any]] = []
        self.msgs: list[dict[str, Any]] = []
        self.pushed: list[dict[str, Any]] = []
        self.cursor = 0

    async def changes(
        self, since: int = 0, limit: int = 500, scope: str = "all", tail: int = 0
    ) -> dict[str, Any]:
        return {
            "cursor": self.cursor or 1,
            "more": False,
            "conversations": list(self.convs),
            "messages": list(self.msgs),
        }

    async def push(
        self, device: str, conversations: list[Any], messages: list[Any]
    ) -> dict[str, Any]:
        self.pushed.append({"device": device, "conversations": conversations, "messages": messages})
        return {"cursor": 2, "accepted": len(conversations) + len(messages), "rejected": []}


def _service(tmp_path: Path, relay: _Relay) -> Any:
    from nanomuse.config import Settings
    from nanomuse.llm import MockLLM
    from nanomuse.server.service import MuseService

    settings = Settings()
    settings.data_dir = tmp_path / "data"
    settings.agent.workspace = tmp_path / "workspace"
    settings.llm.api_key = "test"
    settings.ensure_dirs()
    settings.hub.enabled = False
    settings.hub.device_id = "pc-self"
    settings.hub.name = "Desk"
    settings.sync.side_chats = True
    service = MuseService(settings, llm=MockLLM([]))
    service.sync.client = relay  # type: ignore[assignment]
    service.sync.state["enabled"] = True
    service.sync.state["account_id"] = "acct-1"
    service.app.vault.set("NANOMUSE_CLOUD_KEY", "test-key")
    return service


def test_a_pull_writes_the_owner_to_both_the_state_and_the_thread(tmp_path: Path) -> None:
    """The bug this pins: a pull used to write only `state["device_owners"]`, while `meta()`
    — what the composer's placeholder reads — reads the Thread field. The two disagreed the
    moment another device ran the conversation: the console still named the old device while
    the line already went to the new one. Both are written now, and the thread index too."""
    from nanomuse.server.events import MAIN_THREAD

    relay = _Relay()
    relay.convs = [
        {
            "cid": "cid-main",
            "kind": "main",
            "title": "Main chat",
            "owner_device": "phone-1",
            "owner_device_name": "Pixel 8",
            "deleted": False,
        }
    ]
    service = _service(tmp_path, relay)
    main = service.threads[MAIN_THREAD]
    service.sync.state["cids"][MAIN_THREAD] = "cid-main"
    for row in relay.convs:
        service.sync._apply_conversation(row)  # the pull's per-row step, synchronously
    # routing reads the state...
    assert service.sync.owner_device(main) == "phone-1"
    # ... and the clients read the thread: `meta()` must agree, or the placeholder lies
    assert main.owner_device == "phone-1" and main.owner_device_name == "Pixel 8"
    assert main.meta()["owner_device"] == "phone-1"
    # it survives a restart: the index on disk carries it (service.py reads it back)
    import json

    index = json.loads((service.threads_dir / "index.json").read_text("utf-8"))
    row = next(m for m in index if m["id"] == MAIN_THREAD)
    assert row.get("owner_device") == "phone-1"


def test_a_pulled_side_chat_is_born_with_its_owner(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A side chat this device has never seen arrives with an owner: `thread is None` at
    adoption time, so the create branch must fill the field in — otherwise a line typed on
    the synced-in side chat runs here, in an empty context, instead of on its owner."""
    relay = _Relay()
    relay.convs = [
        {
            "cid": "cid-side",
            "kind": "side",
            "title": "Phone notes",
            "device": "phone-1",
            "device_name": "Pixel 8",
            "owner_device": "phone-1",
            "owner_device_name": "Pixel 8",
            "deleted": False,
        }
    ]
    service = _service(tmp_path, relay)
    # the hub lists the owner, online — the state a real signed-in runtime would see
    monkeypatch.setattr(
        service.hub, "others", lambda: [{"id": "phone-1", "name": "Pixel 8", "online": True}]
    )
    for row in relay.convs:
        service.sync._apply_conversation(row)
    thread = service.sync.thread_of("cid-side")
    assert thread is not None, "the side chat was not created"
    assert thread.owner_device == "phone-1" and thread.owner_device_name == "Pixel 8"
    assert service.sync.owner_device(thread) == "phone-1"
    assert thread.meta()["owner_device"] == "phone-1"
    # and a plain line routes to it, not here
    r = service.sync.route_line(thread, "继续")
    assert r.where is Where.HANDOFF and r.device_id == "phone-1"


def test_the_owner_that_ran_the_turn_marks_itself_on_turn_finished(tmp_path: Path) -> None:
    """§4.1: whoever ran a turn reports itself as the owner. `turn_finished` is the hook that
    catches the turns the `send` path does not — a handed-over run (`source == "device"`),
    which the old `if source == "user"` rule never marked, so the owner never refreshed."""
    relay = _Relay()
    service = _service(tmp_path, relay)
    from nanomuse.server.events import MAIN_THREAD

    main = service.threads[MAIN_THREAD]
    # the relay believes another device owns the conversation right now
    service.sync.state.setdefault("device_owners", {})[MAIN_THREAD] = "phone-1"
    service.sync.turn_finished(main)
    # this device ran the turn, so it holds the context from now on
    assert service.sync.owner_device(main) == "pc-self"
    assert main.owner_device == "pc-self" and main.meta()["owner_device"] == "pc-self"
    # idempotent: a second run here changes nothing
    before = service.sync.state["device_owners"][MAIN_THREAD]
    service.sync.turn_finished(main)
    assert service.sync.state["device_owners"][MAIN_THREAD] == before


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
