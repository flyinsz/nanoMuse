"""nanoMuse: sending a turn under way to the account's other devices, as it happens.

The runtime already publishes everything a run does on its own bus (``nanomuse/server/
webui.py``): ``stream_start`` when text begins, ``delta`` for each piece of text,
``reasoning_delta`` for each piece of thinking, ``stream_end`` when the reply is whole.
Until now the sync engine read only ``status`` frames off that bus (to tell the relay
"working"), so another device saw a line that said a run was happening and then, minutes
later, the final text — never the words as they arrived.

This sender watches the same bus and posts those frames to the relay's
``POST /v1/sync/stream``, which fans them out to the account's other online devices. Three
rules shape it, all for the relay's sake:

* **Batch.** One frame a token would hit the relay's sixty-a-second ceiling; pieces are
  collected and sent as one batch every ``STREAM_INTERVAL_S`` (a quarter second), which is
  four a second at most.
* **This device's runs only.** A turn another device handed here is theirs to report, so
  only a thread this device is *running* and may sync (``eligible``) is sent. A frame whose
  ``from`` is this device is ignored (the relay never echoes our own back anyway).
* **Best effort.** Nothing here is retried, awaited on the turn's path, or worth an error;
  a lost batch only means a moment of text the sync pull still reconciles. The final text
  is never carried here — it goes up over ``push`` as it always did.

It is deliberately a separate object (not more code in the engine) so the engine keeps its
shape and this can be tested on its own. The engine owns one and feeds it bus frames.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from nanomuse.logger import logger

if TYPE_CHECKING:
    from nanomuse.sync.engine import ConversationSync

#: how long a batch waits before it goes (matches engine.STREAM_INTERVAL_S)
STREAM_INTERVAL_S = 0.25
#: the longest text one batch carries; the relay cuts as well, this just keeps frames small
STREAM_TEXT_CAP = 4096


@dataclass
class _Batch:
    """What has piled up since the last post of one run."""

    cid: str
    round: str
    seq: int = 0
    delta: list[str] = field(default_factory=list)
    reasoning: list[str] = field(default_factory=list)
    tool: dict[str, Any] | None = None
    done: bool = False

    def empty(self) -> bool:
        return not (self.delta or self.reasoning or self.tool or self.done)


def stream_round() -> str:
    """An id for one run's stream, so a reader can bucket two runs of one conversation."""
    return f"r-{uuid.uuid4().hex[:12]}"


class StreamSender:
    """Feeds the relay's ``/v1/sync/stream`` from the runtime's own bus frames.

    ``sync`` is the :class:`~nanomuse.sync.engine.ConversationSync` that owns this; it lends
    its ``active``/``_eligible``/``cid_of`` (the same gate the presence path uses) and its
    client. Call :meth:`on_frame` with each bus message; the sender decides what to do.
    """

    def __init__(self, sync: ConversationSync) -> None:
        self.sync = sync
        # thread id → the round id of the run in progress there
        self._rounds: dict[str, str] = {}
        # thread id → the seq last used in the current round
        self._seqs: dict[str, int] = {}
        # thread id → the batch waiting to go
        self._pending: dict[str, _Batch] = {}
        # threads with a flush task already scheduled, so a burst schedules one, not many
        self._scheduled: set[str] = set()
        self._tasks: set[asyncio.Task[Any]] = set()
        # a tool line seen in the same response as text: it rides the next batch (a run
        # rarely calls a tool and writes in the same instant; when it does, both go)
        self._tool: dict[str, dict[str, Any]] = {}

    # ------------------------------------------------------------------ frame in
    def on_frame(self, msg: dict[str, Any]) -> None:
        """One bus frame. Handles the kinds a run produces; ignores everything else, so a
        caller can pass each and every message of the bus without filtering first."""
        kind = msg.get("kind")
        if kind not in ("stream_start", "delta", "reasoning_delta", "stream_end", "tool_delta"):
            return
        thread_id = str(msg.get("thread") or "")
        if not thread_id:
            return
        # this device's own runs only: a thread the other device holds is theirs to report
        thread = self.sync.svc.threads.get(thread_id)
        if thread is None or not self.sync.active or not self.sync._eligible(thread):
            return
        cid = self.sync.cid_of(thread_id)
        if not cid:
            return
        if kind == "stream_start":
            self._begin(thread_id, cid)
        batch = self._pending.get(thread_id)
        if batch is None:
            # a delta with no stream_start (the bus dropped it): open one now so the text
            # still reaches the other devices rather than being dropped on the floor
            round_id = self._begin(thread_id, cid)
            batch = self._pending[thread_id]
            if round_id is None:  # pragma: no cover - _begin always opens one
                return
        if kind == "delta":
            text = str(msg.get("text") or "")
            if text:
                batch.delta.append(text[:STREAM_TEXT_CAP])
        elif kind == "reasoning_delta":
            text = str(msg.get("text") or "")
            if text:
                batch.reasoning.append(text[:STREAM_TEXT_CAP])
        elif kind == "tool_delta":
            tool = self._tool_from(msg)
            if tool:
                batch.tool = tool
        elif kind == "stream_end":
            batch.done = True
        self._flush_soon(thread_id)

    def _begin(self, thread_id: str, cid: str) -> str:
        """Start a fresh round for ``thread_id`` (a new run replaces any half-sent one)."""
        prior = self._pending.get(thread_id)
        if prior is not None and not prior.empty():
            # the previous round ended without a `done`; send what it had so nothing is lost
            self._spawn_post(prior)
        round_id = stream_round()
        self._rounds[thread_id] = round_id
        self._seqs[thread_id] = 0
        self._pending[thread_id] = _Batch(cid=cid, round=round_id)
        return round_id

    def _tool_from(self, msg: dict[str, Any]) -> dict[str, Any] | None:
        name = str(msg.get("name") or msg.get("tool") or "")[:120]
        stage = str(msg.get("stage") or "call")[:20]
        if not name and not stage:
            return None
        tool: dict[str, Any] = {"name": name, "stage": stage}
        summary = str(msg.get("summary") or "")
        if summary:
            tool["summary"] = summary[:160]
        if "ok" in msg:
            tool["ok"] = bool(msg["ok"])
        return tool

    # ------------------------------------------------------------------ batched post
    def _flush_soon(self, thread_id: str) -> None:
        if thread_id in self._scheduled or self.sync._stopped:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return  # no loop (tests, scripts): the caller drives _flush directly
        self._scheduled.add(thread_id)
        task = loop.create_task(self._flush_later(thread_id), name="sync-stream")
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _flush_later(self, thread_id: str) -> None:
        try:
            await asyncio.sleep(STREAM_INTERVAL_S)
        finally:
            self._scheduled.discard(thread_id)
        batch = self._pending.get(thread_id)
        if batch is None or batch.empty():
            if batch is not None and batch.done:
                self._pending.pop(thread_id, None)
            return
        await self._post(batch)
        if batch.done:
            self._pending.pop(thread_id, None)
            self._rounds.pop(thread_id, None)
            self._seqs.pop(thread_id, None)

    def _spawn_post(self, batch: _Batch) -> None:
        """Post an abandoned round now (its `done` never came). Best effort: no loop, no post."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        task = loop.create_task(self._post(batch), name="sync-stream-final")
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _post(self, batch: _Batch) -> None:
        """One batch to the relay. Errors at debug: a lost batch is a moment of text the
        final pull still reconciles, and never worth a retry on the turn's path."""
        if self.sync._stopped:
            return
        self._seqs[batch.cid] = self._seqs.get(batch.cid, 0) + 1
        body: dict[str, Any] = {
            "cid": batch.cid,
            "device": self.sync.svc.hub.device_id,
            "round": batch.round,
            "seq": batch.seq + 1,
            "done": batch.done,
        }
        batch.seq += 1
        if batch.delta:
            body["delta"] = "".join(batch.delta)[:STREAM_TEXT_CAP]
            batch.delta.clear()
        if batch.reasoning:
            body["reasoning"] = "".join(batch.reasoning)[:STREAM_TEXT_CAP]
            batch.reasoning.clear()
        if batch.tool is not None:
            body["tool"] = batch.tool
            batch.tool = None
        self.sync.client.cloud.api_key = self.sync.svc.hub._key()
        try:
            await self.sync.client.stream(body)
        except Exception as exc:  # noqa: BLE001 - a hint, never worth failing a turn over
            logger.debug("sync: stream batch not delivered: {}", exc)

    # ------------------------------------------------------------------ housekeeping
    def forgot(self, thread_id: str) -> None:
        """The thread went: drop whatever it had pending (called by the engine)."""
        self._pending.pop(thread_id, None)
        self._rounds.pop(thread_id, None)
        self._seqs.pop(thread_id, None)
        self._tool.pop(thread_id, None)
        self._scheduled.discard(thread_id)


def now_ms() -> int:
    """Unix milliseconds: only used to stamp a batch for logs, never on the wire."""
    return int(time.time() * 1000)
