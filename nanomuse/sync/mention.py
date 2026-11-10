"""``@<device>`` at the start of a message: the person wants the work done on another
device of the account (contract C7, rule 8). Only a mention that matches a device the hub
lists is taken, and it is removed from the text.

nanoMuse: the default is no longer "this device". The conversation's owner runs the turn
(the device that last ran one here), and `self_id` — this very device — is a target too, so
``@<this device>`` (and ``@本机``) takes the turn back from another owner. See
`docs/tasks/executor-handoff-v2.md`."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

_BOUNDARY = re.compile(r"[\s,:;，：；]")
#: nanoMuse: what a person types to mean "this very device", whatever it is called. Kept to
#: the two the clients actually offer — 简体中文's `@本机` and English's `@This device` (the
#: composer's placeholder in each locale). Any other locale's placeholder still works by
#: name; only these two words are recognised as "this device" on their own.
SELF_WORDS = ("本机", "this device")


@dataclass(frozen=True)
class Mention:
    device_id: str
    device_name: str
    text: str  # what is left once the mention is gone
    # nanoMuse: the mention names this very device (`@本机` or this device's own name)
    self: bool = False


def system_note(device_name: str, device_id: str) -> str:
    """The one line put in front of the turn so the agent hands the work over."""
    return (
        f"The person addressed {device_name} (id {device_id}): run this there with `delegate` "
        "and report what it did."
    )


def self_note(device_name: str) -> str:
    """nanoMuse: the person took the turn back to this device (`@本机`), so the agent runs it
    here. A short line in front tells the model the context changed hands, so a run that was
    happening elsewhere is not mistaken for this device's own memory."""
    return f"The person addressed {device_name}: run this here, in this device's own conversation."


def parse_mention(
    text: str,
    devices: list[dict[str, Any]],
    self_id: str = "",
    self_name: str = "",
) -> Mention | None:
    """``@Pixel 8 open the calendar`` → the device named "Pixel 8" and "open the calendar".

    Case-insensitive. A device's whole name at the start wins (the longest when two names
    share a start); failing that, the first word after ``@`` as a prefix of exactly one
    device's name (``@pix`` → Pixel 8). None when nothing matches — the text is then an
    ordinary message, ``@`` and all.

    nanoMuse: this very device is a target too. ``@本机`` (or ``@this device``) and this
    device's own name (``self_name``) both come back as a :class:`Mention` with
    ``self=True`` and ``device_id == self_id``, so the caller can take the turn back from
    another owner. ``devices`` may hold this device's own entry; it is matched the same way."""
    s = text.lstrip()
    if not s.startswith("@") or len(s) < 2:
        return None
    rest = s[1:]
    rest_l = rest.lower()
    # nanoMuse: `@本机` (and the other self words) name this device first, before anything else
    if self_id:
        for word in SELF_WORDS:
            wl = word.lower()
            if rest_l.startswith(wl) and (
                len(rest) == len(word) or _BOUNDARY.match(rest[len(word)])
            ):
                remainder = rest[len(word) :].lstrip(" \t,:;，：；")
                return Mention(
                    device_id=self_id,
                    device_name=self_name or word,
                    text=remainder,
                    self=True,
                )
    # every device the hub lists is a candidate, this one included (nanoMuse)
    candidates = [d for d in devices if isinstance(d, dict) and str(d.get("id") or "")]
    if self_id and self_name and not any(str(d.get("id")) == self_id for d in candidates):
        candidates.append({"id": self_id, "name": self_name, "this": True})
    best: tuple[int, dict[str, Any]] | None = None
    for d in candidates:
        name = str(d.get("name") or "").strip()
        if not name:
            continue
        n = len(name)
        if rest_l.startswith(name.lower()) and (len(rest) == n or _BOUNDARY.match(rest[n])):
            if best is None or n > best[0]:
                best = (n, d)
    if best is None:
        word = _BOUNDARY.split(rest, 1)[0]
        if not word:
            return None
        hits = [
            d
            for d in candidates
            if str(d.get("name") or "").strip().lower().startswith(word.lower())
        ]
        if len(hits) != 1:
            # several devices share the start ("Mac", "Mac mini"): say which one
            online = [d for d in hits if d.get("online")]
            if len(online) != 1:
                return None
            hits = online
        best = (len(word), hits[0])
    n, device = best
    remainder = rest[n:].lstrip(" \t,:;，：；")
    device_id = str(device.get("id"))
    return Mention(
        device_id=device_id,
        device_name=str(device.get("name") or device_id),
        text=remainder,
        self=bool(self_id) and device_id == self_id,
    )
