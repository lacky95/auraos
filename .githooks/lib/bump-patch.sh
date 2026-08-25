#!/usr/bin/env bash
#
# Bump the root package.json PATCH version by one; print "<old> <new>".
#
# Shared by the pre-commit and post-merge hooks. Does no git staging or
# committing — each hook decides how the change becomes a commit.
#
# Uses `npm version` so semver edge cases (prerelease tags, oddly formatted
# fields) are the package manager's problem, not ours. --no-git-tag-version is
# essential: npm would otherwise commit AND tag, which is exactly the part the
# hooks own. Falls back to an in-place rewrite when npm isn't on PATH, which
# happens in GUI git clients that run hooks with a minimal environment.
#
# Exits 1 without touching anything when there is nothing sane to bump.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
pkg="$root/package.json"
[ -f "$pkg" ] || { echo "[bump] no root package.json" >&2; exit 1; }

current=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pkg" | head -1)
[ -n "$current" ] || { echo "[bump] no \"version\" field" >&2; exit 1; }
printf '%s' "$current" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+' \
  || { echo "[bump] version '$current' is not semver" >&2; exit 1; }

if command -v npm >/dev/null 2>&1 &&
   (cd "$root" && npm version patch --no-git-tag-version >/dev/null 2>&1); then
  next=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pkg" | head -1)
else
  # Fallback: rewrite only the first "version" line, so the file's formatting
  # is untouched — a JSON round-trip would reflow it into a whole-file diff.
  major=${current%%.*}
  rest=${current#*.}
  minor=${rest%%.*}
  patch_full=${rest#*.}
  patch=${patch_full%%[!0-9]*}
  suffix=${patch_full#"$patch"}
  next="$major.$minor.$((patch + 1))$suffix"
  tmp=$(mktemp)
  awk -v new="$next" '
    !done && /^[[:space:]]*"version"[[:space:]]*:/ {
      sub(/"version"[[:space:]]*:[[:space:]]*"[^"]*"/, "\"version\": \"" new "\"")
      done = 1
    }
    { print }
  ' "$pkg" > "$tmp"
  mv "$tmp" "$pkg"
fi

echo "$current $next"
