#!/usr/bin/env bash
set -euo pipefail

identity_name="${TERMES_MACOS_SIGNING_IDENTITY:-Termes Connector Local Development}"
keychain="${TERMES_MACOS_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"

if [[ "$identity_name" == "-" ]]; then
  printf 'error: ad-hoc signing is not allowed for Termes Connector permission-stable builds\n' >&2
  exit 1
fi

identities="$(security find-identity -v -p codesigning "$keychain" 2>/dev/null || true)"
if [[ "$identity_name" =~ ^[[:xdigit:]]{40}$ ]]; then
  matches="$(printf '%s\n' "$identities" | awk -v hash="$identity_name" '$2 == hash { print $2 }')"
else
  matches="$(printf '%s\n' "$identities" | awk -v quoted="\"$identity_name\"" 'index($0, quoted) { print $2 }')"
fi

match_count="$(printf '%s\n' "$matches" | awk 'NF { count += 1 } END { print count + 0 }')"
if [[ "$match_count" -ne 1 ]]; then
  printf 'error: expected exactly one valid macOS code-signing identity matching %q, found %s\n' "$identity_name" "$match_count" >&2
  printf 'run: pnpm --filter @termes/desktop-connector setup:macos:signing\n' >&2
  exit 1
fi

printf '%s\n' "$matches"
