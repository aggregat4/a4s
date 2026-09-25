#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: scripts/changelog-notes.sh <app> <version>

Print the release notes section for <version> from apps/<app>/CHANGELOG.md.
<version> accepts vMAJOR.MINOR.PATCH or an app-qualified tag such as
tasklists/v1.5.3. Exits non-zero when the changelog or section is missing.
EOF
}

if [ "$#" -ne 2 ]; then
  usage
  exit 1
fi

notes_repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
notes_app=$1
notes_version=${2#*/}
notes_version=${notes_version#v}

notes_changelog="${notes_repo_root}/apps/${notes_app}/CHANGELOG.md"
if [ ! -f "${notes_changelog}" ]; then
  printf 'no changelog for app %s: %s\n' "${notes_app}" "${notes_changelog}" >&2
  exit 1
fi

# Print the body of the "## [<version>]" section, dropping blank lines around
# the heading and stopping at the next level-2 heading. Versions compare with a
# leading "v" stripped on both sides.
awk -v version="${notes_version}" '
  /^##[[:space:]]/ {
    if (found) exit
    if (match($0, /\[[^][]+]/)) {
      token = substr($0, RSTART + 1, RLENGTH - 2)
      sub(/^v/, "", token)
      if (token == version) {
        found = 1
        next
      }
    }
    next
  }
  found {
    if ($0 ~ /^[[:space:]]*$/) {
      pending++
      next
    }
    while (printed && pending > 0) {
      print ""
      pending--
    }
    pending = 0
    print
    printed = 1
  }
  END {
    if (!found) {
      printf "no changelog section for version %s in %s\n", version, FILENAME > "/dev/stderr"
      exit 1
    }
  }
' "${notes_changelog}"
