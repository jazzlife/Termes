#!/usr/bin/env bash
set -euo pipefail

connector_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app="$connector_dir/src-tauri/target/release/bundle/macos/Termes Connector.app"
entitlements="$connector_dir/src-tauri/Entitlements.plist"

cd "$connector_dir"
pnpm exec tauri build --bundles app
codesign --force --deep --sign - --entitlements "$entitlements" "$app"
codesign --verify --deep --strict --verbose=2 "$app"

printf 'macOS test bundle: %s\n' "$app"
