#!/usr/bin/env bash
set -euo pipefail

connector_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script_dir="$connector_dir/scripts"
app="$connector_dir/src-tauri/target/release/bundle/macos/Termes Connector.app"
entitlements="$connector_dir/src-tauri/Entitlements.plist"
identity_hash="$("$script_dir/resolve-macos-signing-identity.sh")"

cd "$connector_dir"
pnpm exec tauri build --bundles app
codesign --force --deep --options runtime --timestamp=none \
  --sign "$identity_hash" \
  --entitlements "$entitlements" \
  "$app"
codesign --verify --deep --strict --verbose=2 "$app"

authority="$(codesign -dvv "$app" 2>&1 | awk -F= '$1 == "Authority" && !found { print $2; found = 1 }')"
if [[ -z "$authority" ]]; then
  printf 'error: built app is ad-hoc signed\n' >&2
  exit 1
fi

printf 'macOS signing identity: %s (%s)\n' "$authority" "$identity_hash"
printf 'designated requirement: %s\n' "$(codesign -d -r- "$app" 2>&1)"
printf 'macOS test bundle: %s\n' "$app"
