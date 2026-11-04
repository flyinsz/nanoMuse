#!/usr/bin/env python3
"""Push a set of files to another device of the account over the hub.

A one-off for handing the web console's build to the machine that serves it, which sits on a
network this machine cannot reach (no route, and the far end cannot reach back either). The hub
is the one path both ends share, and `file.put` is the frame it takes base64 file contents in;
`file.put` is not in `always_ask_tools`, so nothing has to be approved at the far end.

    python scripts/local/push-files.py --to pc-27f0b06595de --root /tmp/nm-push

Each file is pushed by its path under --root, so a tar unpacked there lands where it was packed
from. Files are pushed one frame each: a whole tree in one frame is megabytes of base64, and the
relay's frames are not meant to be that big.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from nanomuse.cloud import CLOUD_KEY  # noqa: E402
from nanomuse.hub.client import HubClient  # noqa: E402
from nanomuse.vault.vault import CredentialVault  # noqa: E402


def settings() -> tuple[str, str, str]:
    """The relay's hub address, the account's key and this machine's device id."""
    import os

    data = Path(os.path.expanduser("~/.nanomuse"))
    vault = CredentialVault(data / "vault.enc", data / "vault.key")
    key = vault.get(CLOUD_KEY) or ""
    if not key:
        raise SystemExit("no nanoMuse Cloud key in the vault; sign in first")
    app = json.loads((data / "app-settings.json").read_text("utf-8"))
    device = (app.get("hub") or {}).get("device_id") or ""
    base = (app.get("endpoints") or {}).get("cloud") or "https://muse.pidio.com"
    ws = base.replace("https://", "wss://").replace("http://", "ws://").rstrip("/") + "/v1/hub"
    return ws, key, device


async def push(to: str, root: Path, dest: str, only: list[str]) -> int:
    ws, key, device = settings()
    files = sorted(p for p in root.rglob("*") if p.is_file())
    if only:
        files = [p for p in files if any(p.match(pat) for pat in only)]
    if not files:
        print("nothing to push")
        return 1
    sent = 0
    hub = HubClient(url=ws, api_key=key, device_id=device, name="push", actions=[])
    hub.start()
    try:
        # the socket is up when `connected` is set; without it the first call races the handshake
        for _ in range(100):
            if hub.connected.is_set():
                break
            await asyncio.sleep(0.1)
        else:
            raise SystemExit("the relay never let this device in")
        for p in files:
            rel = p.relative_to(root)
            target = str(Path(dest) / rel) if dest else str(rel)
            raw = p.read_bytes()
            try:
                out = await hub.call(
                    to,
                    "file.put",
                    {"path": target, "data": base64.b64encode(raw).decode("ascii"), "force": True},
                    timeout=60.0,
                )
            except Exception as exc:  # noqa: BLE001 — one file must not stop the rest
                print(f"  FAIL {target}: {exc}")
                continue
            if isinstance(out, dict) and (out.get("result") or {}).get("bytes") == len(raw):
                sent += 1
                print(f"  ok   {target} ({len(raw)} B)")
            else:
                print(f"  ?    {target}: {str(out)[:120]}")
    finally:
        await hub.stop()
    print(f"\n{sent}/{len(files)} pushed")
    return 0 if sent == len(files) else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--to", required=True, help="the device's hub id")
    ap.add_argument("--root", required=True, help="local directory to push from")
    ap.add_argument("--dest", default="", help="absolute directory on the far end")
    ap.add_argument("--only", action="append", default=[], help="glob to limit to (repeatable)")
    a = ap.parse_args()
    return asyncio.run(push(a.to, Path(a.root), a.dest, a.only))


if __name__ == "__main__":
    raise SystemExit(main())
