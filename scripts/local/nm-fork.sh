#!/usr/bin/env bash
# Fork maintenance for flyinsz/nanoMuse. Three subcommands, nothing else.
#
#   nm-fork.sh sync              pull upstream/main into the fork's main
#   nm-fork.sh marks             every place we touched an upstream file
#   nm-fork.sh release <ver>     upstream shipped an OpenMinis release: subtree pull + rebrand
#
# Remotes this expects (see README.md):
#   origin     https://github.com/flyinsz/nanoMuse.git    our fork, the only one we push to
#   upstream   https://github.com/nano-muse/nanoMuse.git  read only
#   openminis  https://github.com/OpenMinis/OpenMinis.git read only, for `release`
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# GitHub is unreachable from the sandbox without the local proxy; git has no proxy set
# globally so it is passed per command. Override with NM_PROXY= when you are somewhere else.
PROXY="${NM_PROXY:-http://127.0.0.1:7890}"
git_p() { https_proxy="$PROXY" http_proxy="$PROXY" git "$@"; }

die() { printf '%s\n' "$*" >&2; exit 1; }

preflight() {
    git rev-parse --git-dir >/dev/null 2>&1 || die "not a git checkout"
    for r in origin upstream; do
        git remote get-url "$r" >/dev/null 2>&1 || die "no remote '$r' — see scripts/local/README.md"
    done
}

# ── sync ─────────────────────────────────────────────────────────────────────
# Only our own files may differ from upstream/main: the plan document, scripts/local/.
# Anything else means an upstream file was edited, and the plan says those edits live
# behind a `// nanoMuse:` mark and nowhere else.
cmd_sync() {
    preflight
    git diff-index --quiet HEAD -- || die "uncommitted changes; commit or stash first"
    git_p fetch upstream --tags
    git checkout main
    if git merge-base --is-ancestor upstream/main main; then
        echo "main is already ahead of upstream/main"
    else
        git rebase upstream/main
    fi
    git_p push origin main
    echo
    echo "our own files vs upstream/main:"
    git diff --stat upstream/main main -- . ':(exclude)docs/tasks' ':(exclude)scripts/local' || true
    echo
    echo "upstream files we have edited (must all carry a '// nanoMuse:' mark):"
    cmd_marks
}

# ── marks ────────────────────────────────────────────────────────────────────
# CONTRIBUTING rule 3: new code in new files; when an upstream file must change, add a
# `// nanoMuse:` comment at the spot, one change per spot. This lists those spots so a
# rebase conflict can be resolved by looking at the mark, not by reading a whole file.
cmd_marks() {
    local base="${1:-upstream/main}" any=0
    # git grep reads the blob, so it works whatever a work-tree shim does to `grep`
    while IFS=: read -r _rev f n; do
        [ -n "$f" ] || continue
        any=1
        printf '  %3s marks  %s\n' "$n" "$f"
    done < <(git grep -c 'nanoMuse:' main -- \
        'android/src/android/app/src/main/java/com/openminis/*' \
        'android/src/ios/Agent/*' 'android/src/ios/Views/*' \
        'android/src/ios/MinisApp.swift' 2>/dev/null || true)
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        case "$f" in
        */io/github/nanomuse/*|*NanoMuse/*|*nm_strings.xml) continue ;;
        esac
        if ! git grep -q 'nanoMuse:' main -- "$f" 2>/dev/null; then
            printf '  UNMARKED  %s\n' "$f"
            any=1
        fi
    done < <(git diff --name-only "$base" main 2>/dev/null || true)
    [ "$any" = 1 ] || echo "  (no upstream file edited)"
}

# ── release ──────────────────────────────────────────────────────────────────
# Upstream squashes a private tree into android/ roughly monthly and takes no pull
# requests there. CONTRIBUTING gives the recipe; this runs it. Run it on a branch.
cmd_release() {
    local ver="${1:-}"
    [ -n "$ver" ] || die "usage: nm-fork.sh release 1.14"
    preflight
    git diff-index --quiet HEAD -- || die "uncommitted changes; commit or stash first"
    git_p fetch openminis --tags
    git checkout -b "openminis-$ver"
    git subtree pull --prefix=android openminis "$ver" -m "Merge OpenMinis $ver"
    # binary icons: ours win, they are regenerated below
    git checkout --ours -- 'android/src/android/app/src/main/res/mipmap-*' \
        'android/src/ios/Assets.xcassets/AppIcon.appiconset' \
        'android/src/ios/Resources/AlternateIcons' || true
    # our marks, then the rebrand
    echo
    echo "resolve the conflicts at the '// nanoMuse:' marks, then:"
    echo "  python scripts/rebrand.py && python scripts/gen-android-icons.py && python scripts/gen-ios-icons.py"
    echo "  python scripts/rebrand.py   # must print 'clean' the second time"
}

case "${1:-}" in
sync) shift; cmd_sync "$@" ;;
marks) shift; cmd_marks "$@" ;;
release) shift; cmd_release "$@" ;;
*) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
