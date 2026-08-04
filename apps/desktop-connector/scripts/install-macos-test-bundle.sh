#!/usr/bin/env bash
set -euo pipefail

connector_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script_dir="$connector_dir/scripts"
app="$connector_dir/src-tauri/target/release/bundle/macos/Termes Connector.app"
installed_app="/Applications/Termes Connector.app"
executable="$installed_app/Contents/MacOS/termes-desktop-connector"
transaction_dir=""
staged_app=""
previous_app=""
installed_replacement=false
was_running=false
completed=false

restore_previous_installation() {
  if [[ "$installed_replacement" == true && -e "$installed_app" ]]; then
    rm -rf "$installed_app"
  fi
  if [[ -n "$previous_app" && -e "$previous_app" ]]; then
    mv "$previous_app" "$installed_app"
  fi
  if [[ "$was_running" == true && -d "$installed_app" ]] &&
    ! pgrep -f "^${executable//./\\.}$" >/dev/null 2>&1; then
    open -na "$installed_app" >/dev/null 2>&1 || true
  fi
}

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [[ "$completed" != true ]]; then
    restore_previous_installation
  fi
  if [[ -n "$transaction_dir" && -d "$transaction_dir" ]]; then
    rm -rf "$transaction_dir"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

if [[ -L "$installed_app" ]]; then
  printf 'error: refusing to replace symlinked install path: %s\n' "$installed_app" >&2
  exit 1
fi
if [[ -e "$installed_app" && ! -d "$installed_app" ]]; then
  printf 'error: install path is not an app directory: %s\n' "$installed_app" >&2
  exit 1
fi

identity_hash="$("$script_dir/resolve-macos-signing-identity.sh")"
bash "$script_dir/build-macos-test-bundle.sh"
source_requirement="$(codesign -d -r- "$app" 2>&1 | awk '/^designated => / { print }')"
if [[ -z "$source_requirement" ]]; then
  printf 'error: built app has no designated requirement\n' >&2
  exit 1
fi
if [[ -d "$installed_app" ]]; then
  codesign --verify --deep --strict --verbose=2 "$installed_app"
  existing_requirement="$(codesign -d -r- "$installed_app" 2>&1 | awk '/^designated => / { print }')"
  if [[ -z "$existing_requirement" ]]; then
    printf 'error: existing app has no designated requirement\n' >&2
    exit 1
  fi
  if [[ "$existing_requirement" != "$source_requirement" ]]; then
    printf 'error: existing app designated requirement differs; refusing to replace its TCC identity\n' >&2
    exit 1
  fi
fi

transaction_dir="$(mktemp -d '/Applications/.termes-connector-install.XXXXXX')"
case "$transaction_dir" in
  /Applications/.termes-connector-install.*) ;;
  *)
    printf 'error: unsafe installation transaction path: %s\n' "$transaction_dir" >&2
    exit 1
    ;;
esac
staged_app="$transaction_dir/Termes Connector.app"
previous_app="$transaction_dir/Previous Termes Connector.app"

/usr/bin/ditto "$app" "$staged_app"
codesign --verify --deep --strict --verbose=2 "$staged_app"
staged_requirement="$(codesign -d -r- "$staged_app" 2>&1 | awk '/^designated => / { print }')"
if [[ -z "$staged_requirement" ]]; then
  printf 'error: staged app has no designated requirement\n' >&2
  exit 1
fi
if [[ "$staged_requirement" != "$source_requirement" ]]; then
  printf 'error: staged app designated requirement differs from the built bundle\n' >&2
  exit 1
fi
staged_authority="$(codesign -dvv "$staged_app" 2>&1 | awk -F= '$1 == "Authority" && !found { print $2; found = 1 }')"
if [[ -z "$staged_authority" ]]; then
  printf 'error: staged app is ad-hoc signed\n' >&2
  exit 1
fi

if pgrep -f "^${executable//./\\.}$" >/dev/null 2>&1; then
  was_running=true
  pkill -TERM -f "^${executable//./\\.}$"
  for _ in $(seq 1 40); do
    pgrep -f "^${executable//./\\.}$" >/dev/null 2>&1 || break
    sleep 0.25
  done
fi
if pgrep -f "^${executable//./\\.}$" >/dev/null 2>&1; then
  printf 'error: Termes Connector did not stop cleanly\n' >&2
  exit 1
fi

if [[ -e "$installed_app" ]]; then
  mv "$installed_app" "$previous_app"
fi
installed_replacement=true
mv "$staged_app" "$installed_app"

codesign --verify --deep --strict --verbose=2 "$installed_app"
installed_requirement="$(codesign -d -r- "$installed_app" 2>&1 | awk '/^designated => / { print }')"
if [[ -z "$installed_requirement" ]]; then
  printf 'error: installed app has no designated requirement\n' >&2
  exit 1
fi
if [[ "$installed_requirement" != "$source_requirement" ]]; then
  printf 'error: installed app designated requirement differs from the built bundle\n' >&2
  exit 1
fi

open -na "$installed_app"
for _ in $(seq 1 40); do
  if pgrep -f "^${executable//./\\.}$" >/dev/null 2>&1; then
    completed=true
    printf 'installed Termes Connector with stable signing identity %s\n' "$identity_hash"
    printf 'designated requirement: %s\n' "$installed_requirement"
    exit 0
  fi
  sleep 0.25
done

printf 'error: installed Termes Connector did not start\n' >&2
exit 1