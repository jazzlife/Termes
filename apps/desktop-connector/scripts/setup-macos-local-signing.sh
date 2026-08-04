#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
identity_name="${TERMES_MACOS_SIGNING_IDENTITY:-Termes Connector Local Development}"

if [[ "$identity_name" == "-" ]]; then
  printf 'error: TERMES_MACOS_SIGNING_IDENTITY must not be the ad-hoc identity (-)\n' >&2
  exit 1
fi

if identity_hash="$("$script_dir/resolve-macos-signing-identity.sh" 2>/dev/null)"; then
  printf 'permission-stable macOS signing identity is ready: %s (%s)\n' "$identity_name" "$identity_hash"
  exit 0
fi

cat >&2 <<EOF
error: no valid code-signing identity named "$identity_name" was found.

Provision an Apple Development or Developer ID Application identity and set
TERMES_MACOS_SIGNING_IDENTITY to its name or SHA-1 hash.

For a local-only test identity, create it without exporting its private key:
  1. Open Keychain Access -> Certificate Assistant -> Create a Certificate.
  2. Name it "Termes Connector Local Development".
  3. Select Identity Type "Self Signed Root" and Certificate Type "Code Signing".
  4. Store it in the Login Keychain and set Code Signing trust to Always Trust.
  5. Run this command again.

This script deliberately does not generate PEM/PKCS#12 private-key files or
accept passwords on the command line.
EOF
exit 1