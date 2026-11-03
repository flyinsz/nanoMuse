#!/usr/bin/env python3
"""Add the three strings the device-conversation path needs to every locale.

CONTRIBUTING: a user-visible string is written in English first, then 简体中文, then every
other locale the file already has. This does the mechanical half: the English text in
``values/`` and the Simplified Chinese in ``values-zh/``, and the English text again in the
rest so nothing shows a missing string. A locale whose translation is not English is left
alone once it has one, so this can be run again after a human fills one in.

    python scripts/local/nm-strings.py            # write
    python scripts/local/nm-strings.py --check    # say what is missing, change nothing
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RES = ROOT / "android/src/android/app/src/main/res"

NEW = {
    "nm_device_step_failed": "failed: %1$s",
    "nm_device_failed": "%1$s could not finish: %2$s",
    "nm_device_stopped": "Stopped. %1$s was told to end it.",
}

ZH = {
    "nm_device_step_failed": "失败：%1$s",
    "nm_device_failed": "%1$s 没能做完：%2$s",
    "nm_device_stopped": "已停止，并且通知了 %1$s 结束这次任务。",
}


def escape(text: str) -> str:
    return text.replace("'", "\\'")


def locales() -> list[Path]:
    return sorted(RES.glob("values*/nm_strings.xml"))


def add(path: Path, items: dict[str, str]) -> list[str]:
    """Put the missing keys before </resources>; returns the keys actually added."""
    text = path.read_text("utf-8")
    have = set(re.findall(r'<string name="([^"]+)"', text))
    missing = [(k, escape(v)) for k, v in items.items() if k not in have]
    if not missing:
        return []
    lines = "".join(f'    <string name="{k}">{v}</string>\n' for k, v in missing)
    if not text.rstrip().endswith("</resources>"):
        raise SystemExit(f"{path}: no closing </resources>")
    head = text.rstrip()[: -len("</resources>")].rstrip("\n")
    path.write_text(f"{head}\n{lines}</resources>\n", "utf-8")
    return [k for k, _ in missing]


def main() -> int:
    check = "--check" in sys.argv
    if check:
        for path in locales():
            text = path.read_text("utf-8")
            have = set(re.findall(r'<string name="([^"]+)"', text))
            gone = sorted(k for k in NEW if k not in have)
            if gone:
                print(f"{path.relative_to(ROOT)}: missing {', '.join(gone)}")
        return 0
    total = 0
    for path in locales():
        # values/ is English, values-zh/ is 简体中文, everything else copies the English for
        # now: a wrong-language line is visible and gets fixed, a missing one crashes a build.
        items = ZH if path.parent.name == "values-zh" else NEW
        added = add(path, items)
        if added:
            total += len(added)
            print(f"{path.relative_to(ROOT)}: +{len(added)}")
    print(f"{total} strings added")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
