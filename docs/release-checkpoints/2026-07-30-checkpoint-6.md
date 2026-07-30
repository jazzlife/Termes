# Checkpoint 6 — Production Connector round trip and macOS permission refresh

- Public origin: `https://termes.nado.work`
- Connector platform: macOS arm64
- Connector bundle identifier: `app.turtlelab.termes.connector`
- Installed test bundle: `/Applications/Termes Connector.app`

## Production Connector verification

A fresh, project-scoped pairing was completed with the signed macOS test bundle. The Connector established its outbound authenticated WebSocket, entered the online state, and continued reporting heartbeats to the production API.

A real `macos.system.info` command traversed the complete production path:

`Termes API → device command → Connector WebSocket → native adapter → command result → Termes API`

The result completed successfully with the macOS platform contract. No credential, pairing code, cookie, or keychain secret was recorded in this document.

## Protocol correction

Connector protocol timestamps are now serialized as millisecond-precision RFC 3339 UTC values with the `Z` suffix. This matches the API datetime schema for pairing, heartbeat, acknowledgment, and result messages.

## Permission correction

The stale permission display had two independent causes:

1. The old Accessibility action opened System Settings without first making the native macOS trust request.
2. The Connector did not refresh its native permission snapshot when focus returned from System Settings.

The corrected Connector now:

- invokes the native Accessibility trust request before the user enters System Settings
- leaves the native Accessibility prompt visible instead of immediately covering it with System Settings
- invokes the native Screen Capture request and falls back to the exact Screen & System Audio Recording settings pane when the OS does not present a prompt
- exposes separate permission-request and settings actions
- refreshes the native permission snapshot whenever the Connector window regains focus
- sends the refreshed snapshot in subsequent heartbeats

macOS consent was not bypassed. The final installed bundle was observed in both Accessibility and Screen & System Audio Recording privacy registration paths. During verification, consent remained denied intentionally; after focus return the Connector UI and production API agreed on:

- Accessibility: denied
- Screen Capture: denied
- Input Control: denied
- Process Inspection: granted

The production Connector remained online, and the observed heartbeat age was below one second.

## Signing constraint

The test bundle is ad-hoc signed because this Mac has no valid Developer ID code-signing identity. A rebuild changes the ad-hoc code identity and can invalidate an earlier TCC grant even when the bundle identifier is unchanged. The final verified artifact was installed at the stable `/Applications/Termes Connector.app` path. Stable permission persistence across future releases requires Developer ID signing and notarization.

## Verification

Fresh checks passed after the final source change:

- Desktop Connector TypeScript typecheck
- permission focus-refresh regression test
- Rust format check
- Rust clippy with warnings denied
- all 8 Rust unit tests
- macOS release bundle build
- strict deep code-signature verification
- production fresh pairing and online heartbeat
- native Accessibility prompt remains visible
- Screen Capture fallback opens the correct privacy pane and registers Termes Connector
- focus-return refresh matches the production heartbeat permission snapshot
- repository lint
- repository build
- repository test: 120 passed, 2 skipped, 0 failed
