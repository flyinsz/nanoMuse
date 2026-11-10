#!/usr/bin/env python3
"""Put a `nanoMuse:` mark on every added block in an upstream file that has none.

`AGENTS.md` says an edit inside an upstream file carries a `// nanoMuse:` comment, so the
fork stays mergeable and a reviewer can see what is ours. Kotlin follows it; the Python
and TypeScript sides mostly do not, and those are the edits a future upstream merge will
trip over — an unmarked block is indistinguishable from upstream's own code, so a
conflict cannot be resolved without re-deriving the change.

This walks the unstaged diff of an upstream file, and for each added hunk that carries no
mark, inserts one line above it:

    Kotlin / TypeScript:  // nanoMuse: <why>
    Python:               # nanoMuse: <why>

The `<why>` is required, and so is the fact that it must be *true*: the script cannot tell
what a block does. Pass `--why "..."`; for several hunks in one file it is the same
sentence, so write one that fits all of them, or mark the file by hand.

Idempotent: a hunk that already has a mark (in any line of the hunk) is left alone, so
running it twice changes nothing.

Usage
-----
    python3 scripts/mark-user-edits.py --why "..." FILE [FILE ...]
    python3 scripts/mark-user-edits.py --why "..." --check FILE      # report, change nothing

Then review the diff: the mark is placed at the hunk's first added line, which is usually
the function or the statement the change belongs to, but a hunk that starts mid-expression
needs the mark moved by hand.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MARK = re.compile(r"(?://|#)\s*nanoMuse:")


def comment_for(path: str) -> str:
    return "#" if path.endswith((".py", ".sh", ".toml", ".yml", ".yaml")) else "//"


def diff_lines(path: str) -> list[str]:
    proc = subprocess.run(
        ["git", "diff", "HEAD", "--unified=0", "--", path],
        cwd=ROOT, capture_output=True, text=True,
    )
    return proc.stdout.splitlines()


def hunks(lines: list[str]) -> list[tuple[int, int]]:
    """(header index, first added-line index) for each hunk in a unified=0 diff."""
    out: list[tuple[int, int]] = []
    i = 0
    while i < len(lines):
        if lines[i].startswith("@@"):
            j = i + 1
            while j < len(lines) and not lines[j].startswith("@@"):
                j += 1
            out.append((i, j))
        i += 1
    return out


def plan(path: str) -> list[tuple[int, list[str]]]:
    """[(file line number, the hunk's added lines)] for each unmarked block, to mark.

    With `--unified=0` the hunk header `@@ -a,b +c,d @@` gives the file line the added
    block starts at, which is where the mark goes.
    """
    lines = diff_lines(path)
    if not lines:
        return []
    inserts: list[tuple[int, str]] = []
    for start, _ in hunks(lines):
        header = lines[start]
        m = re.search(r"\+(\d+)(?:,(\d+))?", header)
        if not m or m.group(2) == "0":
            continue  # a pure deletion: nothing added, nothing to mark
        add_at = int(m.group(1))
        end = start + 1
        while end < len(lines) and not lines[end].startswith("@@"):
            end += 1
        body = [line[1:] for line in lines[start + 1:end] if line.startswith("+") and not line.startswith("+++")]
        if not body:
            continue
        if any(MARK.search(line) for line in body):
            continue  # already marked
        inserts.append((add_at, body))
    return inserts


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--why", required=True, help="one sentence saying what the edit is for")
    ap.add_argument("--check", action="store_true", help="report what would change, write nothing")
    ap.add_argument("files", nargs="+")
    args = ap.parse_args()

    total = 0
    for rel in args.files:
        path = ROOT / rel
        if not path.is_file():
            print(f"skip (not a file): {rel}")
            continue
        found = plan(rel)
        if not found:
            print(f"ok   {rel} — every added block already marked")
            continue
        total += len(found)
        mark = f"{comment_for(rel)} nanoMuse: {args.why}"
        for line_no, body in sorted(found, key=lambda x: -x[0]):
            first = body[0]
            indent = re.match(r"\s*", first).group(0)
            print(f"{'would mark' if args.check else 'mark'} {rel}:{line_no}  ({first.strip()[:60]})")
            if args.check:
                continue
            text = path.read_text()
            lines = text.splitlines(keepends=True)
            # insert before the hunk's first added line: index is line_no - 1
            lines.insert(line_no - 1, f"{indent}{mark}\n")
            path.write_text("".join(lines))
    if args.check and total:
        print(f"\n{total} unmarked block(s); run again without --check to insert the marks")
        return 1
    if not args.check and total:
        print(f"\ninserted {total} mark(s). Review with `git diff`, then move any mark that landed mid-expression.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
