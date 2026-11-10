"""nanoMuse: who runs a line, decided from the context rather than from a prefix.

Upstream's rule (contract C7, rule 8) is: the default is always *this* device, and only an
``@<device>`` at the start sends the work elsewhere — and even then the *local* agent decides
whether to call ``delegate``. This module changes the default: a conversation has an
**owner** (the device that last ran a turn of it, so the one holding the whole context —
tool traces, reasoning, pictures), and a plain line goes to the owner. A mention still wins:
``@<device>`` hands it there, ``@本机`` (or this device's own name) takes it back.

Everything here is pure — devices in, a decision out — so it is unit-tested without a hub.

The decision is one of:

* ``RUN_HERE`` — this device runs the turn (it is the owner, or it was addressed);
* ``handoff`` — another device runs it on the conversation it already holds;
* ``unroutable`` — the named device is offline (or unknown), so the caller says so rather
  than sending the line nowhere.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any

from nanomuse.sync.mention import parse_mention


class Where(Enum):
    RUN_HERE = "here"
    HANDOFF = "handoff"
    UNROUTABLE = "unroutable"


@dataclass(frozen=True)
class Route:
    """What to do with one line: where it runs, the text left for it, and who it is for."""

    where: Where
    text: str
    #: the device that runs it ("" when it runs here)
    device_id: str = ""
    device_name: str = ""
    #: why it is unroutable, for the caller's message ("" otherwise)
    reason: str = ""


def device_by_id(devices: list[dict[str, Any]], device_id: str) -> dict[str, Any] | None:
    """The hub's entry for ``device_id``, or None when the hub does not list it."""
    for d in devices:
        if isinstance(d, dict) and str(d.get("id") or "") == device_id:
            return d
    return None


def online(devices: list[dict[str, Any]], device_id: str) -> bool:
    """Whether the hub says ``device_id`` is connected right now. A device the hub does not
    list reads as offline (it was forgotten, or never announced itself)."""
    d = device_by_id(devices, device_id)
    return bool(d and d.get("online"))


def resolve(
    text: str,
    devices: list[dict[str, Any]],
    self_id: str,
    self_name: str,
    owner_id: str,
) -> Route:
    """Decide where ``text`` runs.

    ``devices`` is the hub's list of the account's other devices (``Hub.others()``);
    ``owner_id`` is the conversation's owner device id ("" when it has none yet, which means
    the turn began here and runs here). A mention beats the owner, always.

    A mention that names this device (``@本机``, or this device's own name) runs here and
    clears the owner — the caller records that. A mention of another device hands off, but
    only when the hub says that device is online: an offline owner does not swallow the
    line, it is refused with a reason the caller shows.
    """
    mention = parse_mention(text, devices, self_id, self_name)
    if mention is not None and (mention.text or True):
        # a mention that resolves is honoured even with empty text (the person may be
        # switching the owner and typing nothing else is odd, but not ours to refuse)
        if mention.self:
            return Route(
                Where.RUN_HERE, mention.text or text, device_id=self_id, device_name=self_name
            )
        if online(devices, mention.device_id):
            return Route(
                Where.HANDOFF,
                mention.text,
                device_id=mention.device_id,
                device_name=mention.device_name,
            )
        return Route(
            Where.UNROUTABLE,
            mention.text,
            device_id=mention.device_id,
            device_name=mention.device_name,
            reason="offline",
        )
    # no mention: the owner runs it. No owner, or the owner is this device: run here.
    if not owner_id or owner_id == self_id:
        return Route(Where.RUN_HERE, text, device_id=self_id, device_name=self_name)
    if online(devices, owner_id):
        name = ""
        d = device_by_id(devices, owner_id)
        if d is not None:
            name = str(d.get("name") or "")
        return Route(Where.HANDOFF, text, device_id=owner_id, device_name=name or owner_id)
    # the owner holds the context but is not here: do not silently run it here, where the
    # model has none of that history — say so instead
    d = device_by_id(devices, owner_id)
    name = str((d or {}).get("name") or owner_id)
    return Route(
        Where.UNROUTABLE, text, device_id=owner_id, device_name=name, reason="owner_offline"
    )


def should_mark_owner(route: Route) -> bool:
    """Whether the route means this device becomes (or stays) the conversation's owner."""
    return route.where is Where.RUN_HERE
