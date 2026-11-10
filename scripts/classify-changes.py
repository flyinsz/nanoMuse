#!/usr/bin/env python3
"""Sort a working tree into the piles a pull request needs, so a branch carries only what
it must.

The upstream rules are in `AGENTS.md` ("Two trees, two sets of rules"): our code lives in
new files under `io.github.nanomuse.*` / `NanoMuse/`, and an edit inside an upstream file
carries a `// nanoMuse:` comment. This script turns that convention into a checkable list.

The handoff-v2 plan (`docs/tasks/executor-handoff-v2.md` §八) sets a second rule that
shapes the piles: the relay and the runtime are written **in upstream's own style, to be
proposed upstream** — "地基先合，客户端各自独立 PR". Those edits carry no `nanoMuse:`
mark on purpose, and that is not a miss. Only the clients are fork-only overlays.

Piles
-----
ours        New files, ours end to end. A PR would carry the fork; not proposed.
proposable  Upstream files (relay, runtime) edited in upstream's own style, meaning to be
            offered back. `--require-clean` does not require a mark here, because a mark
            would be wrong: it labels fork code.
overlay     Client trees (Android, iOS) edited under the fork rule. Each spot needs a
            `// nanoMuse:` mark — that is what keeps the fork mergeable on the next
            upstream merge, and what a reviewer looks for.
upstream-fix
            An overlay whose mark reads `// nanoMuse(fix):`. Reserve it for an edit that
            *repairs upstream's own behaviour* rather than adding ours: a bug every user of
            upstream hits. Those are the ones worth proposing on their own — one concern,
            no fork context. The tag is a claim the author makes, not something this script
            can verify. A fork feature marked `(fix)` is a mistake, not a miss this catches.

Usage
-----
    python3 scripts/classify-changes.py                 # the whole tree
    python3 scripts/classify-changes.py --json          # machine-readable for an agent
    python3 scripts/classify-changes.py --require-clean # exit 1 on an unmarked client overlay

`--require-clean` is the CI-shaped check for the client trees only.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# The upstream trees, and which rule governs an edit inside each.
#
#   "fork"      a client tree (AGENTS.md: new code in new files, edits carry `// nanoMuse:`)
#   "proposable" the relay, the runtime and the console: written in upstream's own style to
#                be offered back (executor-handoff-v2 §八 "地基先合"). No mark is expected —
#                a mark would label the code as fork-only, which is the opposite of the aim.
# The web console is proposable too: `web/src` is upstream's, and our stream/owner work is
# meant to go back with it.
UPSTREAM_TREES = {
    "android": ("android/src/android/app/src/main/java/com/openminis", "fork"),
    "ios": ("android/src/ios/Minis", "fork"),
    "relay": ("cloud/nanomuse_cloud", "proposable"),
    "runtime": ("nanomuse", "proposable"),
    "console": ("web/src", "proposable"),
}
# Our new code, by the convention in AGENTS.md.
OUR_PREFIXES = ("io/github/nanomuse", "NanoMuse/")
# Generated or binary: the built web console, hidden dirs, fixtures.
SKIP_SUFFIXES = (".png", ".webp", ".apk", ".jks", ".db", ".tar.gz")
SKIP_PREFIXES = ("nanomuse/server/static/",)

# An overlay edit: the upstream file's rule for touching it. `(fix)` marks a repair of
# upstream behaviour, the pile worth a standalone PR. Both comment styles the trees use:
# `//` for Kotlin and TypeScript, `#` for Python.
MARK_PLAIN = re.compile(r"(?://|#)\s*nanoMuse:")
MARK_FIX = re.compile(r"(?://|#)\s*nanoMuse\(fix\):")


def changed_files() -> list[str]:
    """Every file this branch touches: staged, unstaged and untracked."""
    out: set[str] = set()
    for args in (
        ["git", "diff", "--name-only", "HEAD"],
        ["git", "diff", "--name-only", "--cached"],
        ["git", "ls-files", "--others", "--exclude-standard"],
    ):
        proc = subprocess.run(args, cwd=ROOT, capture_output=True, text=True)
        out.update(line for line in proc.stdout.splitlines() if line.strip())
    return sorted(out)


def is_new(path: str) -> bool:
    """Untracked, or added since HEAD — the file did not exist upstream."""
    if subprocess.run(
        ["git", "ls-files", "--others", "--exclude-standard", "--", path],
        cwd=ROOT, capture_output=True, text=True,
    ).stdout.strip():
        return True
    proc = subprocess.run(
        ["git", "diff", "--name-status", "HEAD", "--", path],
        cwd=ROOT, capture_output=True, text=True,
    )
    return proc.stdout.startswith("A")


def upstream_tree(path: str) -> tuple[str, str] | None:
    """(tree name, rule) for an upstream path, or None when it is not in an upstream tree.

    A path under ours (`io/github/nanomuse`, `NanoMuse/`) is never an upstream edit even
    though it sits inside an upstream directory.
    """
    if any(ours in path for ours in OUR_PREFIXES):
        return None
    for name, (prefix, rule) in UPSTREAM_TREES.items():
        if path.startswith(prefix):
            return name, rule
    return None


def marks(path: str) -> tuple[int, int]:
    """(plain marks, fix marks) in the file's *added* lines only.

    Reading added lines keeps this honest: a mark that was already upstream, or one that
    simply moved, is not this branch's edit.
    """
    proc = subprocess.run(
        ["git", "diff", "HEAD", "--unified=0", "--", path],
        cwd=ROOT, capture_output=True, text=True,
    )
    text = proc.stdout
    if not text:  # untracked: everything in it is new
        try:
            text = (ROOT / path).read_text(errors="replace")
        except OSError:
            return 0, 0
    added = [line[1:] for line in text.splitlines() if line.startswith("+") and not line.startswith("+++")]
    body = "\n".join(added)
    return len(MARK_PLAIN.findall(body)), len(MARK_FIX.findall(body))


def classify(require_clean: bool) -> tuple[dict[str, list[dict]], int]:
    piles: dict[str, list[dict]] = {"ours": [], "proposable": [], "overlay": [], "upstream-fix": []}
    unmarked: list[str] = []
    for path in changed_files():
        if path.endswith(SKIP_SUFFIXES) or path.startswith(SKIP_PREFIXES):
            continue
        found = upstream_tree(path)
        if found is None:
            # docs, scripts, tests: ours, and a PR against upstream would carry the whole
            # fork's context. Sorted into "ours" so the count is complete.
            piles["ours"].append({"path": path, "why": "new file" if is_new(path) else "not an upstream tree"})
            continue
        tree, rule = found
        if is_new(path):
            piles["ours"].append({"path": path, "why": f"new file in an upstream tree ({tree})"})
            continue
        if rule == "proposable":
            piles["proposable"].append({"path": path, "why": f"{tree}: upstream's own style, meant to go back"})
            continue
        plain, fix = marks(path)
        if plain == 0:
            unmarked.append(path)
            piles["overlay"].append({"path": path, "why": f"{tree}: upstream file, NO // nanoMuse: mark", "unmarked": True})
        elif fix == 0:
            piles["overlay"].append({"path": path, "why": f"{tree}: {plain} marked spot(s)"})
        else:
            piles["upstream-fix"].append({"path": path, "why": f"{tree}: {fix} of {plain} spot(s) marked (fix)", "tree": tree})
    exit_code = 1 if (require_clean and unmarked) else 0
    return piles, exit_code


def report(piles: dict[str, list[dict]], unmarked: list[str]) -> None:
    labels = {
        "upstream-fix": "UPSTREAM-FIX  (repairs upstream's own bug; offer back on its own)",
        "proposable": "PROPOSABLE    (relay/runtime/console, upstream's style, meant to go back)",
        "overlay": "OVERLAY       (client tree edited; each spot carries // nanoMuse:)",
        "ours": "OURS          (our own files; a PR would carry the fork)",
    }
    for key in ("upstream-fix", "proposable", "overlay", "ours"):
        items = piles[key]
        print(f"\n{labels[key]}  — {len(items)}")
        for item in items[:40]:
            flag = "  ⚠ unmarked" if item.get("unmarked") else ""
            print(f"  {item['path']}{flag}")
        if len(items) > 40:
            print(f"  … and {len(items) - 40} more")
    if unmarked:
        print(f"\n⚠ {len(unmarked)} client file(s) edited with no `// nanoMuse:` mark.")
        print("  The next upstream merge will conflict here. Mark the spot, or move the edit")
        print("  into a new file under io.github.nanomuse.*")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", action="store_true", help="print the piles as JSON")
    ap.add_argument("--require-clean", action="store_true", help="exit 1 when an overlay edit has no mark")
    args = ap.parse_args()

    piles, code = classify(args.require_clean)
    if args.json:
        print(json.dumps(piles, indent=2, ensure_ascii=False))
        return code
    report(piles, [i["path"] for i in piles["overlay"] if i.get("unmarked")])
    return code

if __name__ == "__main__":
    sys.exit(main())
