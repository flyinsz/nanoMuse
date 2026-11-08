"""Conversation sync (contracts C7 and C8): the runtime's chats are the same on every device
of the account.

The relay (``/v1/sync/*``, relay 0.19) keeps the text of the account's conversations —
user and final assistant messages, attachment names and sizes — and a change counter per
account. This engine:

* **pushes** the person's message the moment it is sent, the assistant's final text when
  the turn ends (debounced two seconds), a chat's title when it is created or renamed, a
  tombstone when it is deleted — and the **whole eligible history** of this runtime,
  oldest first in pages of 200, on sign-in and when sync is turned on again (every event
  is unmarked, so the first conversation goes up along with the rest);
* **pulls** on start, on sign-in, on the hub's ``sync`` frame and every 60 seconds, and
  applies what came in ``seq`` order: new conversations become threads (title, the device
  that started them), new messages become timeline events sorted into time order and
  history for the agent, tombstones remove messages and threads.

Every synced thread has a ``cid`` (kept in ``data_dir/sync.json`` next to the cursor);
every synced event carries a ``mid`` and ``synced: true`` in the timeline. The main chat
is ``kind: main`` and **one conversation for the whole account** (C8): the first device to
push it names its cid, every other device adopts that cid on its first pull (``main_exists``
says which when two race), and the local main chat shows the union of its own turns and the
other devices' — merged by ``created_at``, local first on a tie, deduplicated by ``mid``.
A pulled message this device wrote (the echo of its own push) is never added twice. Chats
addressed to another device (``Thread.device``) and chats another device opened here
(``Thread.remote_from``) are not synced — the other device has the same conversation as
its own.

**Main first** (C9, relay 0.20). By default only the main conversation syncs: pushes send
``kind: main`` alone and pulls ask for ``scope=main``. *Settings → Data controls → Also sync
side chats* (``side_chats`` here, default from ``[sync] side_chats``) turns the side chats
on for this device: they are pushed too, pulls ask for ``scope=all``, and the moment it is
turned on one pull from ``since=0&scope=all&tail=300`` brings the other devices' side chats
(idempotent by ``mid`` / ``cid``). Off again stops pushing and pulling them; what was synced
stays where it is. A fresh device's first pull asks for the **tail** — the newest 300
messages and their conversations — so the chat is on screen in seconds; older history stays
on the devices that wrote it. **Presence**: a turn that starts on a synced conversation
posts ``working: true`` to the relay right after the person's message went up, and
``working: false`` after the assistant's text; the hub's ``working`` frames from the other
devices land in a small map (:meth:`working_view`) the web app reads, and leave it when the
reply arrives, when the device says done, or ten minutes after ``at``. Presence is best
effort: never retried, never awaited on the turn's path, errors at debug.

**Whose conversations** (C10). Every local conversation that was ever pushed to, or pulled
from, an account carries that account's ``id`` (``GET /v1/me`` → ``account.id``) as its
``owner`` in ``sync.json``; one created while signed out and never synced has none. Signed
in as B, the list shows B's and the ownerless ones; A's stay on disk, hidden, and are never
pushed into B's account — an ownerless one becomes B's on its first push. Signed out,
everything local is shown. When the signed-in account changes, the account-scoped state
starts over: the cursor goes to 0 (a fresh ``tail`` pull), the presence map and the hub's
device list are cleared, and the main chat — one conversation per account on the relay — is
re-homed: the old account's main chat is kept as a hidden thread (``main_of``) and the new
account's own comes back when it has one, else a fresh one begins. Mappings are kept, so
switching back shows everything again. Sign-out alone clears nothing but the key.

Nothing here reaches the network when the account is signed out; ``sync_off`` from the
relay flips the local switch, ``bad_key`` pauses until the next sign-in."""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from nanomuse.cloud import CloudError
from nanomuse.logger import logger
from nanomuse.schema import Message
from nanomuse.server.events import MAIN_THREAD, now_iso
from nanomuse.server.webui import current_thread
from nanomuse.sync.client import SyncClient

if TYPE_CHECKING:
    from nanomuse.server.service import MuseService, Thread

PUSH_DELAY_S = 2.0
PULL_EVERY_S = 60.0
BATCH = 200
PAGE = 500
# the first pull of a fresh device: the newest messages of the scope, not the whole store (C9)
TAIL = 300
# a `working: true` without a `false` stands this long (the device may have lost its network)
WORKING_TTL_S = 10 * 60
# how many POSTs one push may make before it lets go (a brand-new device with a long history)
MAX_ROUNDS = 50
# the quietest gap between two presence posts of one run (0.31): a step that changes
# every second still reads on the other devices as one moving line, not a stream
PRESENCE_INTERVAL_S = 2.0
# the quietest gap between two stream batches of one run (C13 §4): the words of a turn
# under way here go out batched, so a long answer does not spend the relay's per-connection
# frame budget (60 a second) on one frame per token
STREAM_INTERVAL_S = 0.25
# the longest tool step text one stream batch carries (the relay caps it again on arrival)
STREAM_SUMMARY_CAP = 160
# how often the status watcher checks it was not dropped for slowness (a full queue in
# EventBus.publish discards the subscriber; the watcher notices and subscribes again)
WATCH_POLL_S = 30.0


def new_cid() -> str:
    return str(uuid.uuid4())


def _unix(ts: str | None) -> int:
    """A timeline ``ts`` (ISO) → Unix seconds; now when unreadable."""
    if ts:
        try:
            return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp())
        except ValueError:
            pass
    return int(time.time())


def _iso(unix: int | float | None) -> str:
    try:
        return datetime.fromtimestamp(float(unix or 0), UTC).isoformat(timespec="milliseconds")
    except (OverflowError, OSError, ValueError):
        return now_iso()


def _tool_step(event: object) -> dict[str, Any] | None:
    """A tool card off the bus (websocket `event` / `update`), as the step the other devices draw.

    The web app's own cards are built in ``server/webui.py``: a call is an event whose ``type``
    is ``tool`` with the tool's name, the model's own words for the step (``title``) and the
    technical summary; the answer is an ``update`` of the same card carrying ``status`` and the
    first of ``output``. Both become one step — the card's own words where it has them, so the
    line reads the way the person watching this device reads it.

    None for a card that is not a tool's (a notice, a question, an artifact, a message): the
    other devices draw those through the conversation sync, and a step frame for each would
    say the same thing twice. A card without a tool name is skipped for the same reason.
    """
    if not isinstance(event, dict):
        return None
    if str(event.get("type") or "") != "tool":
        return None
    name = str(event.get("tool") or "").strip()
    if not name:
        return None
    status = str(event.get("status") or "")
    result = status in ("ok", "error", "blocked")
    words = str(event.get("title") or event.get("summary") or "").strip()
    if result:
        output = str(event.get("output") or "").strip()
        summary = output or words
    else:
        summary = words
    return {
        "thread": str(event.get("thread") or ""),
        "name": name,
        "stage": "result" if result else "call",
        "summary": summary,
        "ok": status != "error" and status != "blocked",
    }


class ConversationSync:
    def __init__(self, svc: MuseService):
        self.svc = svc
        self.path = svc.data_dir / "sync.json"
        self.state: dict[str, Any] = {
            "account_id": "",
            "cursor": 0,
            "enabled": bool(svc.settings.cloud.sync),
            # C9: this device's side chats too (and the other devices'); off = main only
            "side_chats": bool(svc.settings.sync.side_chats),
            "cids": {},  # thread id → cid
            "titles": {},  # thread id → the title last pushed
            # C13: thread id → the device id last pushed as this conversation's owner, so a
            # push goes out when the owner moves (`@Desk`) and stays quiet when it has not.
            "device_owners": {},
            # C10: thread id → the account (`account.id`) it was synced with; absent = none
            "owners": {},
            # C10: account id → the thread that holds that account's main chat while another
            # account is signed in (hidden; restored as `main` when the account comes back)
            "mains": {},
        }
        self._load()
        self.client = SyncClient(svc.hub.cloud)
        self._push_task: asyncio.Task[None] | None = None
        self._pull_task: asyncio.Task[int] | None = None
        self._timer: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()
        self._tasks: set[asyncio.Task[Any]] = set()
        # set by stop(): nothing of this engine talks to the relay after that
        self._stopped = False
        # 0.31: what this device last announced per thread — (state, detail) of the run
        # under way — so a step change re-posts only when there is something new to say
        self._announced: dict[str, tuple[str, str]] = {}
        self._presence_scheduled: set[str] = set()
        self._status_queue: asyncio.Queue[dict[str, Any]] | None = None
        # 0.31 / C13 §4: the words of the turns running here, batched for the relay. One
        # accumulating buffer per conversation (a run makes its own round id), flushed on a
        # timer: {thread id: {cid, round, delta, reasoning, tool, seq}}.
        self._streams: dict[str, dict[str, Any]] = {}
        # the round a conversation's turn is running under: one bubble per turn, kept for the
        # whole turn so its words, its reasoning and its steps land in the same one
        self._stream_rounds: dict[str, str] = {}
        # conversations whose buffered batch is already waiting out its interval
        self._flushing: set[str] = set()
        # presence (C9): cid → {thread, device, device_name, state, detail, at} for the other
        # devices' turns under way; a frame says so, a reply or ten minutes clears it
        self.working: dict[str, dict[str, Any]] = {}
        # a one-off pull from zero waiting its turn (side chats just turned on)
        self._pull_from_zero = False
        # a 401 from the relay: nothing more until the next sign-in
        self._paused = False
        self._applying = False
        # the scheduled push is still waiting out its delay (it may be rescheduled); once it
        # is on the wire a new request queues a second round behind it instead
        self._push_waiting = False
        self._push_again: float | None = None
        self.last_pull_at: str | None = None
        self.last_push_at: str | None = None
        self.last_error = ""

    # ------------------------------------------------------------------ what this device keeps
    def _load(self) -> None:
        try:
            data = json.loads(self.path.read_text("utf-8"))
        except (OSError, ValueError):
            return
        if isinstance(data, dict):
            for key in ("account_id", "cursor", "enabled", "side_chats"):
                if key in data:
                    self.state[key] = data[key]
            for key in ("cids", "titles", "owners", "mains", "device_owners"):
                if isinstance(data.get(key), dict):
                    self.state[key] = {str(k): str(v) for k, v in data[key].items()}

    def _save(self) -> None:
        try:
            # written aside and moved on, like every other state file here: a device losing
            # power mid-write would otherwise leave half a JSON file, and `_load` reads that
            # as no state at all — the cursor, the thread↔cid map and the hidden main chats
            # gone, so the next pull starts from nothing
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.state, ensure_ascii=False, indent=1), "utf-8")
            tmp.replace(self.path)
        except OSError as exc:  # pragma: no cover
            logger.warning("could not save sync state: {}", exc)

    @property
    def enabled(self) -> bool:
        return bool(self.state.get("enabled", True))

    @property
    def side_chats(self) -> bool:
        return bool(self.state.get("side_chats", False))

    @property
    def scope(self) -> str:
        return "all" if self.side_chats else "main"

    @property
    def cursor(self) -> int:
        return int(self.state.get("cursor") or 0)

    @property
    def active(self) -> bool:
        """Signed in, switched on, not paused by a refused key."""
        return self.enabled and self.svc.hub.signed_in and not self._paused

    def cid_of(self, thread_id: str) -> str | None:
        v = self.state["cids"].get(thread_id)
        return str(v) if v else None

    def thread_of(self, cid: str) -> Thread | None:
        for tid, c in self.state["cids"].items():
            if c == cid:
                return self.svc.threads.get(tid)
        return None

    # ------------------------------------------------------------------ whose (C10)
    @property
    def account_id(self) -> str:
        """The account the last sign-in named (``account.id``); "" before any."""
        return str(self.state.get("account_id") or "")

    def owner_of(self, thread_id: str) -> str:
        """The account a conversation was synced with, "" when none (never synced)."""
        return str(self.state["owners"].get(thread_id) or "")

    def device_owner_of(self, thread_id: str) -> str:
        """The device holding a conversation's context (C13), "" before the relay has said."""
        return str(self.state["device_owners"].get(thread_id) or "")

    def _note_device_owner(self, thread_id: str, device: str) -> None:
        """Record the relay's word on a conversation's owner (C13, impl §A).

        The relay is the authority: what this device last sent says only what it asked for, and
        the relay may decline a push whose row it already holds newer. Taking the reply is also
        how a move made on another device (`@Desk` from the phone) reaches this one.
        """
        if not thread_id or self.device_owner_of(thread_id) == device:
            return
        self.state["device_owners"][thread_id] = device
        self._save()

    def visible(self, thread: Thread) -> bool:
        """Shown in the list (C10): signed in, the current account's and the ownerless ones;
        signed out, everything. Another account's main chat (``main_of``) is that account's."""
        if not self.svc.hub.signed_in or not self.account_id:
            return True
        if thread.main_of:
            return thread.main_of == self.account_id
        owner = self.owner_of(thread.id)
        return not owner or owner == self.account_id

    def _mine(self, thread: Thread) -> bool:
        """May move for the signed-in account: its own, or not yet anyone's (C10 rule 3)."""
        if thread.main_of and thread.main_of != self.account_id:
            return False
        owner = self.owner_of(thread.id)
        return not owner or not self.account_id or owner == self.account_id

    def _adopt(self, thread_id: str) -> None:
        """The conversation is the signed-in account's from now on (first push or pull)."""
        if self.account_id and self.state["owners"].get(thread_id) != self.account_id:
            self.state["owners"][thread_id] = self.account_id
            self._save()

    def _eligible(self, thread: Thread) -> bool:
        """Synced from here: not a chat for or from another device, the signed-in account's
        or nobody's yet (C10), and — with side chats off (C9) — the main chat only."""
        if thread.device or thread.remote_from or thread.main_of:
            return False
        if not self._mine(thread):
            return False
        return self.side_chats or thread.id == MAIN_THREAD

    def _cid_for(self, thread: Thread) -> str:
        cid = self.cid_of(thread.id)
        if cid is None:
            cid = new_cid()
            self.state["cids"][thread.id] = cid
            self._save()
        self._adopt(thread.id)
        return cid

    def view(self) -> dict[str, Any]:
        """What the Data controls page shows: the switch, whether it can be used, the cursor."""
        return {
            "enabled": self.enabled,
            "side_chats": self.side_chats,
            "available": self.svc.hub.signed_in,
            "paused": self._paused,
            "cursor": self.cursor,
            "last_pull_at": self.last_pull_at,
            "last_push_at": self.last_push_at,
            "error": self.last_error,
            "working": self.working_view(),
        }

    def working_view(self) -> list[dict[str, Any]]:
        """The other devices' turns under way (C9): ``[{thread, cid, device, device_name,
        state, detail, at}]``, ``at`` in Unix seconds, entries older than ten minutes
        dropped. ``state``/``detail`` (0.31) say what the run is doing right now."""
        cutoff = int(time.time()) - WORKING_TTL_S
        for cid in [c for c, w in self.working.items() if int(w.get("at") or 0) < cutoff]:
            del self.working[cid]
        return [dict(w) for w in self.working.values()]

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> None:
        """After the hub is up: a first pull, a push of what is new, and the minute timer."""
        self._stopped = False
        if self._timer is None or self._timer.done():
            self._timer = asyncio.create_task(self._tick(), name="sync-timer")
        if self._status_queue is None:
            self._status_queue = self.svc.bus.subscribe()
            self._keep(asyncio.create_task(self._watch_status(), name="sync-status"))
        if self.active:
            self.pull_soon()
            self.push_soon(delay=PUSH_DELAY_S)

    async def stop(self) -> None:
        """Cancel every task of the engine — the timer, the push and the pull, and the one-off
        presence and delete requests — and wait until each has ended, so that no request to
        the relay is still open (or about to open) when the cloud client closes after this.
        A task created on the way out (a turn ending as the server stops) is refused."""
        self._stopped = True
        tasks = [
            t
            for t in (self._timer, self._push_task, self._pull_task, *self._tasks)
            if t is not None and not t.done()
        ]
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.wait(tasks)

    async def _tick(self) -> None:
        while True:
            await asyncio.sleep(PULL_EVERY_S)
            if self.active:
                self.pull_soon()

    def account_changed(self, account_id: str) -> None:
        """Signed in (again). A different account (C10 rule 4) starts from cursor 0 — a fresh
        tail pull — with the presence map and the hub's device list cleared and the main chat
        re-homed; the mappings of the account that was here before are kept, so switching
        back shows its conversations again."""
        self._paused = False
        self.last_error = ""
        previous = self.account_id
        if account_id and account_id != previous:
            self.state.update(account_id=account_id, cursor=0)
            self.working.clear()
            self._announced.clear()
            self._presence_scheduled.clear()
            # a batch still buffered belongs to the account that just signed out: dropping it
            # is right (its conversation is another account's now), and nothing sends it
            self._streams.clear()
            self._stream_rounds.clear()
            self._flushing.clear()
            self._save()
            self._rehome_main(previous, account_id)
            if previous:
                logger.info("sync: a different account signed in; its conversations are shown")
        if self.active:
            self.pull_soon()
            self.push_soon()

    def _rehome_main(self, previous: str, account_id: str) -> None:
        """The main chat is one conversation per account (C8), so a new account cannot keep
        the old one's: the old main chat becomes a hidden thread marked ``main_of`` and the
        new account's own comes back when it has one, else a fresh one begins. A main chat
        nobody has synced yet stays — it is nobody's and joins the account on its first push."""
        main = self.svc.threads.get(MAIN_THREAD)
        if main is None:
            return
        owner = self.owner_of(MAIN_THREAD)
        restore = str(self.state["mains"].get(account_id) or "")
        if restore not in self.svc.threads:
            restore = ""
        if not restore and (not owner or owner == account_id):
            # the main chat is this account's, or nobody's yet (it joins on its first push)
            return
        if not owner:
            # text written under the previous account and never synced: it stays with that
            # account rather than landing in the new one's main chat
            owner = previous
        has_text = any(ev.get("type") in ("user", "assistant") for ev in main.timeline.events)
        archived = self.svc.rehome_main(owner, restore or None, keep=bool(owner and has_text))
        if archived is not None:
            # the mappings follow the threads: the old main chat keeps its cid and owner
            # under its new id, the restored one takes `main` back
            for key in ("cids", "titles", "owners"):
                value = self.state[key].pop(MAIN_THREAD, None)
                if value is not None:
                    self.state[key][archived.id] = value
            self.state["owners"][archived.id] = owner
            self.state["mains"][owner] = archived.id
        else:
            for key in ("cids", "titles", "owners"):
                self.state[key].pop(MAIN_THREAD, None)
        if restore:
            self.state["mains"].pop(account_id, None)
            for key in ("cids", "titles", "owners"):
                value = self.state[key].pop(restore, None)
                if value is not None:
                    self.state[key][MAIN_THREAD] = value
            self.state["owners"][MAIN_THREAD] = account_id
        self._save()

    def signed_out(self) -> None:
        """The key is gone: nothing more until the next sign-in; what is local stays."""
        for t in (self._push_task, self._pull_task):
            if t is not None and not t.done():
                t.cancel()
        self._paused = False

    def _clear_marks(self) -> None:
        """Every synced event is unsynced again: the next push sends it all (a new account, the
        switch turned back on, the main chat re-homed). Another account's rows are left as
        they are (C10): they are not going anywhere from here."""
        for thread in self.svc.threads.values():
            if self._mine(thread):
                self._clear_thread_marks(thread)

    @staticmethod
    def _clear_thread_marks(thread: Thread) -> None:
        changed = False
        for ev in thread.timeline.events:
            # another device's row is that device's to send again, not ours (C8)
            if ev.get("synced") and not ev.get("via_device"):
                ev["synced"] = False
                changed = True
        if changed:
            thread.timeline.save()

    # ------------------------------------------------------------------ the switch
    async def set_enabled(self, enabled: bool) -> dict[str, Any]:
        """Data controls: off tells the relay (which deletes) and stops; on re-pushes this
        device's conversations and pulls the others'."""
        enabled = bool(enabled)
        relay: dict[str, Any] | None = None
        if self.svc.hub.signed_in:
            self.client.cloud.api_key = self.svc.hub._key()
            relay = await self.client.set_enabled(enabled)
        self.state["enabled"] = enabled
        self._save()
        if enabled:
            self._paused = False
            self.state["titles"] = {}
            self._clear_marks()
            if self.svc.hub.signed_in:
                self.pull_soon()
                self.push_soon()
        else:
            for t in (self._push_task, self._pull_task):
                if t is not None and not t.done():
                    t.cancel()
        return {**self.view(), "relay": relay}

    def set_side_chats(self, on: bool) -> dict[str, Any]:
        """Data controls → *Also sync side chats* (C9). On: this device's side chats go up
        (oldest first, with the next push) and one pull from zero with ``scope=all&tail=300``
        brings the other devices'. Off: they stop moving; what was synced stays."""
        on = bool(on)
        if on == self.side_chats:
            return self.view()
        self.state["side_chats"] = on
        self._save()
        if on and self.active:
            self._pull_from_zero = True
            self.pull_soon()
            self.push_soon(delay=0.5)
        return self.view()

    async def relay_state(self) -> dict[str, Any] | None:
        """The relay's own view (counts, limits), or None when it cannot be asked."""
        if not self.svc.hub.signed_in:
            return None
        self.client.cloud.api_key = self.svc.hub._key()
        try:
            return await self.client.state()
        except CloudError as exc:
            self._note_error(exc)
            return None

    async def delete_remote(self) -> dict[str, Any] | None:
        """“Delete synced conversations”: the relay's store emptied, the switch kept, local
        chats untouched."""
        if not self.svc.hub.signed_in:
            return None
        self.client.cloud.api_key = self.svc.hub._key()
        out = await self.client.wipe()
        self.state["cursor"] = int(out.get("cursor") or self.cursor)
        self._save()
        return out

    # ------------------------------------------------------------------ hooks from the service
    def message_sent(self, thread: Thread) -> None:
        """The person's message is on the timeline: it goes up now (C8, real time), not
        when the turn ends — and right after it, ``working: true`` (C9).

        The turn's own round opens here (C13 §4). A turn is what a round is: the words, the
        steps and the reasoning of one answer belong in one bubble, and a turn may speak more
        than once (a tool call, its answer, then prose), so the round lasts until
        :meth:`turn_finished` rather than until the next message.
        """
        if self.active and self._eligible(thread):
            self.push_soon(delay=0.0)
            self._working_soon(thread, True)
            self._streams.pop(thread.id, None)
            self._stream_rounds.pop(thread.id, None)

    def turn_finished(self, thread: Thread) -> None:
        if self.active and self._eligible(thread):
            self.push_soon(delay=PUSH_DELAY_S)
            self._working_soon(thread, False)
            # the turn is over: the last batch goes, then the frame that closes the round, so
            # the other devices' bubbles settle rather than waiting out their own timeout
            self._flush_stream(thread.id)

    def _working_soon(self, thread: Thread, working: bool) -> None:
        """Presence to the relay once the push it belongs to is through — so the
        conversation exists there and carries the id it ended up with. Off the turn's path,
        never retried, errors at debug."""
        if self._stopped:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._keep(loop.create_task(self._send_working(thread, working), name="sync-working"))

    async def _send_working(self, thread: Thread, working: bool) -> None:
        for _ in range(3):  # a push rescheduled under us: wait for the one that replaced it
            push = self._push_task
            if push is None or push.done():
                break
            # wait for the push without taking on its fate: a cancelled push (rescheduled, or
            # stop() on the way) must not read as this task being cancelled — and when this
            # task is the one cancelled, that ends it here rather than letting it go on to
            # open a connection to the relay while the engine is stopping
            await asyncio.wait({push})
        cid = self.cid_of(thread.id)
        if not cid or not self.active or self._stopped:
            return
        status = self.svc.ui.status.get(thread.id) or {}
        state = str(status.get("state") or "working")
        detail = str(status.get("detail") or "")
        if working:
            self._announced[thread.id] = (state, detail)
        else:
            self._announced.pop(thread.id, None)
        self.client.cloud.api_key = self.svc.hub._key()
        try:
            await self.client.working(
                cid, working, self.svc.hub.device_id, state=state, detail=detail
            )
        except Exception as exc:  # noqa: BLE001 — presence is a hint, never worth a retry
            logger.debug("sync: working={} not delivered: {}", working, exc)

    def status_changed(self, thread_id: str, state: str, detail: str) -> None:
        """The run's step moved on (0.31): presence again with the new state and step.
        Throttled to one post per interval — the task sleeps, then reads the newest status
        and sends only what is still true and still new."""
        if self._stopped or state not in ("working", "waiting"):
            return
        thread = self.svc.threads.get(thread_id)
        if thread is None or not self.active or not self._eligible(thread):
            return
        if self._announced.get(thread_id) == (state, detail):
            return
        if thread_id in self._presence_scheduled:
            return
        self._presence_scheduled.add(thread_id)
        self._keep(asyncio.create_task(self._presence_later(thread), name="sync-presence"))

    async def _presence_later(self, thread: Thread) -> None:
        """One post per interval, until what is announced is what the run is doing: a step
        that lands while a post is under way is caught by the next round, not lost."""
        try:
            while not self._stopped and self.active:
                await asyncio.sleep(PRESENCE_INTERVAL_S)
                status = self.svc.ui.status.get(thread.id) or {}
                state = str(status.get("state") or "")
                if state not in ("working", "waiting"):
                    return  # the run ended while we waited; turn_finished owns the goodbye
                detail = str(status.get("detail") or "")
                if self._announced.get(thread.id) == (state, detail):
                    return
                await self._send_working(thread, True)
        finally:
            self._presence_scheduled.discard(thread.id)

    async def _watch_status(self) -> None:
        """Keep the watcher alive for as long as the engine is up.

        The watcher below is the only route a run's words have to the other devices, and it
        is started once, when the hub comes up — nothing starts it again. So a frame it cannot
        read must not end it: it ends the frame. Restarting here, after a pause, is what keeps
        a single unreadable frame from silencing every run for the rest of the process' life
        (measured: one bad batch at 12:48 and no run reached the relay again that afternoon).
        """
        while not self._stopped:
            try:
                await self._watch_status_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — the watcher outranks the frame it choked on
                logger.warning("sync: the status watcher restarted after {}", exc)
                await asyncio.sleep(WATCH_POLL_S)

    async def _watch_status_once(self) -> None:
        """The bus's status frames (the local run's steps), feeding presence (0.31), and the
        stream frames of the runs under way here, fed to the relay (C13 §4). The bus drops a
        subscriber whose queue filled (a burst of stream frames while this task waited its
        turn), so the wait is bounded: a dropped watcher subscribes itself again rather than
        hanging on a queue nobody fills."""
        try:
            while not self._stopped:
                q = self._status_queue
                if q is None or not self.svc.bus.subscribed(q):
                    if q is not None:
                        self.svc.bus.unsubscribe(q)  # a discard is idempotent either way
                    q = self.svc.bus.subscribe()
                    self._status_queue = q
                    # the frames the drop ate are gone; the runs' own status is the
                    # catch-up, so a step that landed while this healed is not lost
                    for tid, st in (getattr(self.svc.ui, "status", {}) or {}).items():
                        self.status_changed(
                            str(tid), str(st.get("state") or ""), str(st.get("detail") or "")
                        )
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=WATCH_POLL_S)
                except TimeoutError:
                    continue
                # One frame must not end the watcher: a shape this code does not expect costs
                # that frame and nothing more. `_watch_status` restarts after an escape, so
                # even an error raised outside this guard is survivable.
                try:
                    self._watch_status_frame(msg)
                except Exception as exc:  # noqa: BLE001 — one bad frame is not the end
                    logger.warning("sync: a bus frame was dropped: {}", exc)
        finally:
            q = self._status_queue
            if q is not None:
                self.svc.bus.unsubscribe(q)
                if self._status_queue is q:
                    self._status_queue = None

    def _watch_status_frame(self, msg: dict[str, Any]) -> None:
        """Act on one frame from the bus: a run's status, or a piece of the words it is writing."""
        kind = msg.get("kind")
        if kind == "status":
            status = msg.get("status") or {}
            self.status_changed(
                str(status.get("thread") or ""),
                str(status.get("state") or ""),
                str(status.get("detail") or ""),
            )
        elif kind in (
            "delta",
            "reasoning_delta",
            "tool_delta",
            "stream_start",
            "stream_end",
            "event",
            "update",
        ):
            self.stream_frame(kind, msg)

    # ------------------------------------------------------------------ the run's words (C13 §4)
    def stream_frame(self, kind: str, msg: dict[str, Any]) -> None:
        """A bus frame from this device's own run, on its way to the relay's other devices.

        Three shapes arrive here. The model's words come as ``delta`` / ``reasoning_delta`` and
        are batched: they accumulate and go out on a timer, so a long answer costs a handful of
        frames a second rather than one per token (the relay allows 60 a second on one socket).
        A step comes as ``tool_delta`` when it was relayed in, or — for a run started *here* —
        as the ``event`` / ``update`` pair the web app's own tool cards are built from; the card
        is turned into the same step the clients draw (``_tool_step``), so a command and its
        output reach the other devices instead of being dropped on the floor.

        Only the local run's frames are forwarded — a frame that carries a ``round`` was relayed
        *here* from another device (``_apply_stream`` feeds those to the local web app), and
        sending it back would put its words on the relay a second time.
        """
        if self._stopped or not self.active:
            return
        if kind in ("event", "update"):
            step = _tool_step(msg.get("event"))
            if step is None:
                return
            self._stream_step(step)
            return
        if msg.get("round"):
            return
        thread_id = str(msg.get("thread") or "")
        if not thread_id:
            return
        thread = self.svc.threads.get(thread_id)
        if thread is None or not self._eligible(thread):
            return
        if kind == "stream_start":
            return  # the turn's round opens on its first piece; it has no frame of its own
        if kind == "stream_end":
            # One answer of the turn is written out. That is not the end of the *round* (C13 §4):
            # a turn speaks more than once — a tool call, its answer, then prose — and all of it
            # belongs in one bubble. Only the batch is sent here; the round closes in
            # ``turn_finished``.
            self._send_buffer(self._streams.get(thread_id))
            return
        cid = self.cid_of(thread.id)
        if not cid:
            return
        text = str(msg.get("text") or "")
        if not text and kind != "tool_delta":
            return
        buf = self._buffer_for(thread_id, cid)
        if kind == "delta":
            buf["delta"] = (str(buf["delta"]) + text)[-8192:]
        elif kind == "reasoning_delta":
            buf["reasoning"] = (str(buf["reasoning"]) + text)[-8192:]
        else:  # tool_delta
            tool = msg.get("tool") or {}
            if not str(tool.get("name") or ""):
                return
            buf["tool"] = {
                "name": str(tool.get("name") or ""),
                "stage": "result" if tool.get("stage") == "result" else "call",
                "summary": str(tool.get("summary") or "")[:STREAM_SUMMARY_CAP],
                "ok": tool.get("ok") is not False,
            }
        self._stream_flush_soon(thread_id)

    def _buffer_for(self, thread_id: str, cid: str) -> dict[str, Any]:
        """The turn's accumulating buffer, made once per turn.

        The round id lives on the mapping rather than on the buffer, so a buffer emptied by a
        batch keeps naming the same round: every piece of one turn — its words, its reasoning,
        its steps — lands in the bubble the other devices already opened for it.
        """
        buf = self._streams.get(thread_id)
        if buf is None:
            round_id = self._stream_rounds.get(thread_id)
            if round_id is None:
                round_id = new_cid()
                self._stream_rounds[thread_id] = round_id
            buf = {
                "cid": cid,
                "round": round_id,
                "delta": "",
                "reasoning": "",
                "tool": None,
                "seq": 0,
            }
            self._streams[thread_id] = buf
        return buf

    def _stream_step(self, step: dict[str, Any]) -> None:
        """A tool card of this device's own run, sent at once rather than batched: a step is
        one event of its own, not a stream of words, and the other devices should see it the
        moment it happens. The card carries no thread of its own in the way a delta does, so
        the buffer is opened here if the run has not written anything yet.
        """
        if self._stopped or not self.active:
            return
        thread_id = str(step.get("thread") or "")
        if not thread_id:
            return
        thread = self.svc.threads.get(thread_id)
        if thread is None or not self._eligible(thread):
            return
        cid = self.cid_of(thread.id)
        if not cid:
            return
        buf = self._buffer_for(thread_id, cid)
        # anything already written goes first, so the step is not overtaken by the words after it
        if buf.get("delta") or buf.get("reasoning"):
            self._send_buffer(buf)
        buf["seq"] = int(buf.get("seq") or 0) + 1
        self._post_stream(
            str(buf["cid"]),
            str(buf["round"]),
            int(buf["seq"]),
            tool={
                "name": str(step["name"]),
                "stage": str(step["stage"]),
                "summary": str(step.get("summary") or "")[:STREAM_SUMMARY_CAP],
                "ok": step.get("ok") is not False,
            },
        )

    def _stream_flush_soon(self, thread_id: str) -> None:
        """One batch per interval: the buffer keeps accumulating, and the flush already
        scheduled carries whatever is in it when it runs."""
        if self._stopped or thread_id in self._flushing:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._flushing.add(thread_id)
        self._keep(loop.create_task(self._stream_flush_later(thread_id), name="sync-stream"))

    async def _stream_flush_later(self, thread_id: str) -> None:
        try:
            await asyncio.sleep(STREAM_INTERVAL_S)
            self._send_buffer(self._streams.get(thread_id))
        finally:
            self._flushing.discard(thread_id)

    def _flush_stream(self, thread_id: str) -> None:
        """The turn of ``thread_id`` is over: the last batch goes, then the frame that closes the
        turn's round, so the other devices' bubbles settle rather than waiting out a timeout.

        The round is named even when nothing is buffered: a turn whose pieces were all sent
        already still has a bubble on screen, and it has to be told the turn is over.
        """
        buf = self._streams.pop(thread_id, None)
        round_id = self._stream_rounds.pop(thread_id, None)
        if buf is None and round_id is None:
            return
        cid = str((buf or {}).get("cid") or self.cid_of(thread_id) or "")
        if buf is not None:
            self._send_buffer(buf)
        if not cid:
            return
        seq = int((buf or {}).get("seq") or 0) + 1
        self._post_stream(cid, str((buf or {}).get("round") or round_id), seq, done=True)

    def _send_buffer(self, buf: dict[str, Any] | None) -> None:
        """Send what the buffer holds; anything that arrived meanwhile stays for the next
        round, and a batch that would carry nothing is not sent at all."""
        if not buf:
            return
        delta = str(buf.get("delta") or "")
        reasoning = str(buf.get("reasoning") or "")
        tool = buf.get("tool")
        if not delta and not reasoning and not tool:
            return
        buf["delta"] = ""
        buf["reasoning"] = ""
        buf["tool"] = None
        buf["seq"] = int(buf.get("seq") or 0) + 1
        self._post_stream(
            str(buf["cid"]),
            str(buf["round"]),
            int(buf["seq"]),
            delta=delta,
            reasoning=reasoning,
            tool=tool,
        )

    def _post_stream(
        self,
        cid: str,
        round_id: str,
        seq: int,
        delta: str = "",
        reasoning: str = "",
        tool: dict[str, Any] | None = None,
        done: bool = False,
    ) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._keep(
            loop.create_task(
                self._send_stream(cid, round_id, seq, delta, reasoning, tool, done),
                name="sync-stream-post",
            )
        )

    async def _send_stream(
        self,
        cid: str,
        round_id: str,
        seq: int,
        delta: str,
        reasoning: str,
        tool: dict[str, Any] | None,
        done: bool,
    ) -> None:
        if self._stopped or not self.active:
            return
        self.client.cloud.api_key = self.svc.hub._key()
        try:
            await self.client.stream(
                cid,
                self.svc.hub.device_id,
                round_id,
                seq,
                delta=delta,
                reasoning=reasoning,
                tool=tool,
                done=done,
            )
        except Exception as exc:  # noqa: BLE001 — a lost batch costs a few words, never a retry
            logger.debug("sync: stream batch not delivered: {}", exc)

    def thread_changed(self, thread: Thread) -> None:
        """Created or renamed: push now (a rename is one small request)."""
        if self.active and self._eligible(thread):
            self.push_soon(delay=0.2)

    def thread_deleted(self, thread_id: str) -> None:
        cid = self.state["cids"].pop(thread_id, None)
        self.state["titles"].pop(thread_id, None)
        owner = self.state["owners"].pop(thread_id, None)
        if owner and self.state["mains"].get(owner) == thread_id:
            del self.state["mains"][owner]
        self._save()
        for c in [c for c, w in self.working.items() if w.get("thread") == thread_id]:
            del self.working[c]
        self._announced.pop(thread_id, None)
        # a side chat with side chats off: nothing of it moves any more, its copy elsewhere stays
        if (
            cid
            and self.active
            and not self._stopped
            and not self._applying
            and (self.side_chats or thread_id == MAIN_THREAD)
        ):
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                return
            self._keep(loop.create_task(self._delete_remote_conversation(cid), name="sync-delete"))

    def on_frame(self, frame: dict[str, Any]) -> None:
        """The hub says another device pushed: pull when our cursor is behind. Or (C9) that
        a turn started or ended there: the presence map and the web app hear it. Or (C13 §4)
        a batch of that turn's live output: this device's web app draws it."""
        if str(frame.get("from") or "") == self.svc.hub.device_id:
            return
        if frame.get("type") == "working":
            self._apply_working(frame)
            return
        if frame.get("type") == "stream":
            self._apply_stream(frame)
            return
        if int(frame.get("cursor") or 0) > self.cursor and self.active:
            self.pull_soon()

    def _apply_working(self, frame: dict[str, Any]) -> None:
        cid = str(frame.get("cid") or "")
        if not cid:
            return
        thread = self.thread_of(cid)
        if thread is None or not self._eligible(thread):
            return
        device = str(frame.get("from") or "")
        at = int(frame.get("at") or time.time())
        if frame.get("working"):
            self.working[cid] = {
                "thread": thread.id,
                "cid": cid,
                "device": device,
                "device_name": str(frame.get("device_name") or ""),
                "state": str(frame.get("state") or "working"),
                "detail": str(frame.get("detail") or ""),
                "at": at,
            }
        else:
            current = self.working.get(cid)
            # another device's `true` stands: the one that finished is not the one working
            if current is None or (device and current.get("device") != device):
                return
            del self.working[cid]
        self.svc.bus.publish(
            {
                "kind": "working",
                "thread": thread.id,
                "cid": cid,
                "device": device,
                "device_name": str(frame.get("device_name") or ""),
                "state": str(frame.get("state") or "working"),
                "detail": str(frame.get("detail") or ""),
                "working": bool(frame.get("working")),
                "at": at,
            }
        )

    def _apply_stream(self, frame: dict[str, Any]) -> None:
        """Contract C13 §4: a batch of another device's live run, fed to *this* device's web
        app so it draws the turn while it happens — the reverse of what :meth:`_relay_run`
        does for a caller. Filtered exactly as :meth:`_apply_working`: this device's own
        echo, a frame with no conversation, one whose conversation is not held here, and
        one whose thread is not a synced one are all dropped — nothing is drawn on a chat
        this device does not have, or that is not the account's.

        The pieces go to the web app's own streaming entry points (``on_text_delta`` /
        ``on_reasoning_delta`` / ``on_tool_delta`` / ``on_stream_end``), with the frame's
        ``round``, so the Web app buckets this stream by conversation *and* round (a local
        run in the same conversation keeps its own bucket). Those entry points read the
        thread from a contextvar (``server/webui.py``), so it is set to the target thread
        around the call and reset after: a relayed frame lands on its own conversation,
        never on whatever thread the hub's reader task happened to be in."""
        cid = str(frame.get("cid") or "")
        if not cid:
            return
        thread = self.thread_of(cid)
        if thread is None or not self._eligible(thread):
            return
        ui = self.svc.ui
        # ``on_tool_delta`` exists only on the web app's UI; it, and the round-aware
        # ``on_text_delta`` / ``on_reasoning_delta`` beside it, arrived together. A UI that
        # has none of them (a console, a headless one) shows nothing for a relayed stream
        # rather than being called with an argument it does not take.
        if not hasattr(ui, "on_tool_delta"):
            return
        round_id = str(frame.get("round") or "")
        delta = str(frame.get("delta") or "")
        reasoning = str(frame.get("reasoning") or "")
        tool = frame.get("tool")

        def feed() -> None:
            if delta:
                ui.on_text_delta(delta, round_id)
            if reasoning:
                ui.on_reasoning_delta(reasoning, round_id)
            if isinstance(tool, dict):
                ui.on_tool_delta(tool, round_id)
            if frame.get("done"):
                ui.on_stream_end(round_id)

        token = current_thread.set(thread.id)
        try:
            feed()
        finally:
            current_thread.reset(token)

    def _clear_working(self, cid: str, device: str) -> None:
        """The reply from that device arrived: its line goes."""
        current = self.working.get(cid)
        if current is None or current.get("device") != device:
            return
        self._apply_working({"cid": cid, "from": device, "working": False, "at": time.time()})

    def _keep(self, task: asyncio.Task[Any]) -> None:
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _delete_remote_conversation(self, cid: str) -> None:
        self.client.cloud.api_key = self.svc.hub._key()
        try:
            await self.client.delete_conversation(cid)
        except CloudError as exc:
            if exc.code != "no_conversation":
                self._note_error(exc)

    # ------------------------------------------------------------------ scheduling
    def push_soon(self, delay: float | None = None) -> None:
        """Schedule a push ``delay`` seconds from now (``PUSH_DELAY_S`` by default, read when
        the push is scheduled so a test can shorten it)."""
        if delay is None:
            delay = PUSH_DELAY_S
        if not self.active or self._stopped:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        if self._push_task is not None and not self._push_task.done():
            if not self._push_waiting:
                # on the wire already: one more round once it is through (the shorter wait wins)
                self._push_again = (
                    min(self._push_again, delay) if self._push_again is not None else delay
                )
                return
            self._push_task.cancel()
        self._push_task = loop.create_task(self._push_later(delay), name="sync-push")

    async def _push_later(self, delay: float) -> None:
        while True:
            self._push_waiting = True
            try:
                await asyncio.sleep(delay)
            finally:
                self._push_waiting = False
            try:
                await self.push()
            except CloudError:
                pass  # noted by push(); rule 7: nothing is shown, the next trigger tries again
            except Exception:  # noqa: BLE001
                logger.exception("sync push")
            if self._push_again is None:
                return
            delay, self._push_again = self._push_again, None

    def pull_soon(self) -> None:
        if not self.active or self._stopped:
            return
        if self._pull_task is not None and not self._pull_task.done():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._pull_task = loop.create_task(self._pull_quietly(), name="sync-pull")

    async def _pull_quietly(self) -> int:
        try:
            return await self.pull()
        except CloudError:
            pass  # noted by pull()
        except Exception:  # noqa: BLE001
            logger.exception("sync pull")
        return 0

    def _note_error(self, exc: CloudError) -> None:
        """Rule 7: network errors are silent (the next trigger tries again); ``sync_off`` flips
        the switch here; a refused key pauses until the next sign-in."""
        if exc.code == "sync_off":
            self.state["enabled"] = False
            self._save()
            self.last_error = ""
            logger.info("sync: turned off on another device; off here too")
            return
        if exc.status == 401:
            self._paused = True
            self.last_error = "signed_out"
            return
        self.last_error = exc.code
        logger.debug("sync: {}", exc.describe())

    # ------------------------------------------------------------------ push
    def _attachments(self, ev: dict[str, Any]) -> list[dict[str, Any]]:
        out = []
        for f in ev.get("files") or []:
            if isinstance(f, dict):
                out.append(
                    {
                        "name": str(f.get("name") or "")[:200],
                        "mime": str(f.get("mime") or "")[:100],
                        "size": int(f.get("size") or 0),
                    }
                )
        return out

    def _unsynced(self, thread: Thread, cid: str) -> list[tuple[dict[str, Any], dict[str, Any]]]:
        """(event, wire message) for every user / final assistant text not yet on the relay."""
        out: list[tuple[dict[str, Any], dict[str, Any]]] = []
        for ev in thread.timeline.events:
            kind = ev.get("type")
            if kind not in ("user", "assistant") or ev.get("synced") or ev.get("quiet"):
                continue
            if ev.get("via_device"):
                # written on another device: shown here, never pushed as ours
                continue
            if kind == "assistant" and not ev.get("final"):
                continue
            text = str(ev.get("text") or "")
            attachments = self._attachments(ev)
            if not text.strip() and not attachments:
                continue
            mid = str(ev.get("mid") or "")
            if not mid:
                mid = new_cid()
                ev["mid"] = mid
            wire = {
                "mid": mid,
                "cid": cid,
                "role": kind,
                "text": text,
                "created_at": _unix(ev.get("ts")),
            }
            if attachments:
                wire["attachments"] = attachments
            out.append((ev, wire))
        return out

    async def push(self) -> dict[str, Any]:
        """Everything new on this device to the relay, in batches of 200 messages."""
        if not self.active:
            return {"pushed": 0}
        async with self._lock:
            try:
                return await self._push_locked()
            except CloudError as exc:
                self._note_error(exc)
                raise

    async def _push_locked(self) -> dict[str, Any]:
        self.client.cloud.api_key = self.svc.hub._key()
        device = self.svc.hub.device_id
        pushed = 0
        sent = False
        for _round in range(MAX_ROUNDS):
            conversations: list[dict[str, Any]] = []
            messages: list[dict[str, Any]] = []
            pending: list[tuple[Thread, dict[str, Any]]] = []
            for thread in list(self.svc.threads.values()):
                if not self._eligible(thread):
                    continue
                cid = self._cid_for(thread)
                # C13: the owner goes up whenever the relay has not confirmed this device as
                # the holder. `self.state["device_owners"]` holds the relay's word (see
                # `_note_device_owner`), so an empty value means "not confirmed", not "not sent".
                owner_changed = self.device_owner_of(thread.id) != device
                if self.state["titles"].get(thread.id) != thread.title or owner_changed:
                    # An owner that has not been told yet goes up with a fresh `updated_at`: the
                    # relay only rewrites a row whose `updated_at` is not older than the one it
                    # holds, so an unchanged timestamp would leave the owner unrecorded forever.
                    stamp = _unix(thread.updated_at)
                    if owner_changed:
                        stamp = max(stamp, int(time.time()))
                    conversations.append(
                        {
                            "cid": cid,
                            "kind": "main" if thread.id == MAIN_THREAD else "side",
                            "title": thread.title,
                            "created_at": _unix(thread.created_at),
                            "updated_at": stamp,
                            # C13 / impl §A: the device holding this conversation's full context.
                            # This engine holds it for every thread it pushes (`_eligible` keeps
                            # other devices' threads out), so it is the owner. On the wire because
                            # the other devices read it back to know whose turn it is: a phone
                            # that pulls this chat has no other way to learn where it belongs.
                            "owner_device": device,
                        }
                    )
                for ev, wire in self._unsynced(thread, cid):
                    if len(messages) >= BATCH:
                        break
                    messages.append(wire)
                    pending.append((thread, ev))
            if not conversations and not messages:
                break
            sent = True
            out = await self.client.push(device, conversations, messages)
            # the cursor only moves on a pull: the relay's cursor after our POST would skip
            # whatever the other devices pushed in between
            rejected = [r for r in out.get("rejected") or [] if isinstance(r, dict)]
            redirect: dict[str, str] = {}
            for r in rejected:
                if r.get("reason") == "main_exists" and r.get("cid") and r.get("cid_main"):
                    redirect[str(r["cid"])] = str(r["cid_main"])
            if redirect:
                # the account's main chat already has an id: ours takes it, and its messages go
                # again under it on the next round
                for tid, cid in list(self.state["cids"].items()):
                    if cid in redirect:
                        self.state["cids"][tid] = redirect[cid]
                        self.state["titles"].pop(tid, None)
                        logger.info("sync: the main chat adopts the account's conversation id")
            refused_mids = {
                str(r.get("mid")): str(r.get("reason") or "")
                for r in rejected
                if r.get("mid") and r.get("reason") != "main_exists"
            }
            for thread, ev in pending:
                mid = str(ev.get("mid") or "")
                if mid in refused_mids:
                    # a bad row stays bad: do not send it again and again
                    ev["synced"] = True
                    ev["sync_refused"] = refused_mids[mid]
                elif not any(
                    r.get("mid") == mid and r.get("reason") == "main_exists" for r in rejected
                ):
                    ev["synced"] = True
                    pushed += 1
                thread.timeline.save()
            for c in conversations:
                if not any(r.get("cid") == c["cid"] for r in rejected):
                    for tid, cid in self.state["cids"].items():
                        if cid == c["cid"]:
                            self.state["titles"][tid] = c["title"]
            self._save()
            if len(messages) < BATCH and not redirect:
                break
        if pushed:
            self.last_push_at = now_iso()
            logger.debug("sync: {} message(s) pushed", pushed)
        if sent:
            # our rows come back on the next pull (known ids, no change) and the cursor catches up
            self.pull_soon()
        return {"pushed": pushed, "cursor": self.cursor}

    # ------------------------------------------------------------------ pull
    async def pull(self) -> int:
        """What the other devices pushed since our cursor, applied in order. Returns how many
        rows were applied."""
        if not self.active:
            return 0
        async with self._lock:
            try:
                return await self._pull_locked()
            except CloudError as exc:
                self._note_error(exc)
                raise

    async def _pull_locked(self) -> int:
        self.client.cloud.api_key = self.svc.hub._key()
        applied = 0
        # C9: a fresh device (cursor 0) asks for the tail of its scope, not the whole store;
        # side chats just turned on ask once more from zero, for everything, as a tail too
        from_zero = self._pull_from_zero or self.cursor == 0
        self._pull_from_zero = False
        for _page in range(MAX_ROUNDS):
            if from_zero:
                out = await self.client.changes(0, PAGE, scope=self.scope, tail=TAIL)
                from_zero = False
                skipped = int(out.get("skipped") or 0)
                if skipped:
                    logger.info(
                        "sync: the newest {} messages pulled; {} older stay on the relay",
                        TAIL,
                        skipped,
                    )
            else:
                out = await self.client.changes(self.cursor, PAGE, scope=self.scope)
            # The page's conversations first, then its messages, each in seq order: a rename
            # puts a conversation's seq above its messages, and the relay sends every
            # message's conversation along with the page so none of them is an orphan.
            convs = [c for c in out.get("conversations") or [] if isinstance(c, dict)]
            msgs = [m for m in out.get("messages") or [] if isinstance(m, dict)]
            convs.sort(key=lambda c: int(c.get("seq") or 0))
            msgs.sort(key=lambda m: int(m.get("seq") or 0))
            self._applying = True
            try:
                for row in convs:
                    self._apply_conversation(row)
                    applied += 1
                for row in msgs:
                    self._apply_message(row)
                    applied += 1
            finally:
                self._applying = False
            self.state["cursor"] = max(self.cursor, int(out.get("cursor") or 0))
            self._save()
            if not out.get("more"):
                break
        self.last_pull_at = now_iso()
        self.last_error = ""
        if applied:
            logger.info("sync: {} change(s) from the account's other devices", applied)
            # what adoption or a tombstone left unsynced goes up now
            self.push_soon(delay=0.5)
        return applied

    def _apply_conversation(self, row: dict[str, Any]) -> None:
        cid = str(row.get("cid") or "")
        if not cid:
            return
        kind = str(row.get("kind") or "side")
        if kind != "main" and not self.side_chats:
            # C9: side chats stay where they were written; a row that still arrives (an
            # older relay without `scope`) is left alone, as is a copy already here
            return
        thread = self.thread_of(cid)
        if thread is not None and not self._mine(thread):
            # another account's conversation happens to carry this id: not ours to touch
            return
        # C13 (impl §A): the relay's word on this conversation's owner, taken as the truth about
        # it. Local state records only what was *sent*, and a push the relay declined (its row's
        # `updated_at` was newer) would leave the two disagreeing for good — so the reply wins and
        # the local record is brought in line, which is also what makes a move made on another
        # device (`@Desk` there) show up here.
        if thread is not None:
            self._note_device_owner(thread.id, str(row.get("owner_device") or ""))
        if row.get("deleted"):
            if thread is None:
                return
            if thread.id == MAIN_THREAD:
                # the main chat is never deleted here; it starts over on the relay with a new id
                self.state["cids"].pop(thread.id, None)
                self.state["titles"].pop(thread.id, None)
                self._clear_thread_marks(thread)
                self._save()
                return
            self.svc.delete_thread(thread.id)
            return
        title = str(row.get("title") or "").strip()
        if kind == "main":
            main = self.svc.threads.get(MAIN_THREAD)
            if main is None:
                return
            if thread is None or thread.id != MAIN_THREAD:
                # the account's main chat: this device's main adopts its id and sends its
                # own messages into it (rule 4)
                if thread is not None:
                    # a side chat of ours carried that cid: it is the main chat elsewhere
                    self.state["cids"].pop(thread.id, None)
                self.state["cids"][MAIN_THREAD] = cid
                self.state["titles"][MAIN_THREAD] = main.title
                self._clear_thread_marks(main)
                self._save()
                self._adopt(MAIN_THREAD)
            return
        if thread is not None:
            if title and title != thread.title:
                self.state["titles"][thread.id] = title
                self.svc.rename_thread(thread.id, title)
            return
        device = str(row.get("device") or "")
        if device and device == self.svc.hub.device_id:
            # ours, but the mapping was lost (a reset): no second copy
            return
        created = self.svc.create_thread(title or "Side chat")
        created.origin_device = device
        created.origin_device_name = str(row.get("device_name") or "")
        created.created_at = _iso(row.get("created_at"))
        created.updated_at = _iso(row.get("updated_at"))
        self.state["cids"][created.id] = cid
        self.state["titles"][created.id] = created.title
        self._save()
        self._adopt(created.id)
        self.svc._save_index()
        self.svc.bus.publish({"kind": "thread", "thread": created.meta()})

    def _find_event(self, thread: Thread, mid: str) -> dict[str, Any] | None:
        for ev in thread.timeline.events:
            if ev.get("mid") == mid:
                return ev
        return None

    def _apply_message(self, row: dict[str, Any]) -> None:
        cid = str(row.get("cid") or "")
        mid = str(row.get("mid") or "")
        if not cid or not mid:
            return
        thread = self.thread_of(cid)
        if thread is None or not self._eligible(thread):
            return
        existing = self._find_event(thread, mid)
        if row.get("deleted"):
            if existing is not None:
                thread.timeline.remove(existing["id"])
                self.svc.bus.publish(
                    {"kind": "event_removed", "thread": thread.id, "id": existing["id"]}
                )
            return
        if existing is not None:
            return
        device = str(row.get("device") or "")
        if device and device == self.svc.hub.device_id:
            # the echo of our own push (or a row of ours the timeline no longer holds):
            # never a second bubble (C8)
            return
        role = str(row.get("role") or "")
        if role not in ("user", "assistant"):
            return
        text = str(row.get("text") or "")
        event: dict[str, Any] = {
            "type": role,
            "text": text,
            "mid": mid,
            "synced": True,
            "ts": _iso(row.get("created_at")),
        }
        if device:
            event["via_device"] = device
            event["via_device_name"] = str(row.get("device_name") or "")
        if role == "assistant":
            event["final"] = True
        if row.get("truncated"):
            event["truncated"] = True
        attachments = row.get("attachments")
        if isinstance(attachments, list) and attachments:
            # names and sizes only: the files stayed on the device they were made on
            event["files"] = [
                {
                    "name": str(a.get("name") or ""),
                    "size": int(a.get("size") or 0),
                    "mime": str(a.get("mime") or ""),
                    "path": "",
                    "kind": "remote",
                }
                for a in attachments
                if isinstance(a, dict)
            ]
        ev = thread.timeline.add(event)
        # in time order with what is here already (add() appends; the sort is stable, so a
        # local event with the same second stays in front — C8: ties, local first)
        thread.timeline.events.sort(key=lambda e: str(e.get("ts") or ""))
        thread.updated_at = max(thread.updated_at, ev["ts"])
        if role == "assistant" and device:
            # the reply is here: that device's "working…" line goes (C9)
            self._clear_working(cid, device)
        if not thread.busy:
            # the agent reads it as history on its next turn here
            msg = Message.user(text) if role == "user" else Message.assistant(text)
            msg.meta["mid"] = mid
            thread.agent.messages.append(msg)
            thread.agent._save_session()
        self.svc.bus.publish({"kind": "event", "event": ev})
        self.svc.bus.publish({"kind": "thread", "thread": thread.meta()})
