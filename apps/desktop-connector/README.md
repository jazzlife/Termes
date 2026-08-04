# Termes Desktop Connector

## Permission-stable macOS test installation

macOS TCC permissions are bound to the app's code-signing designated requirement, not only its bundle identifier. Do not install an ad-hoc-signed (`codesign --sign -`) Connector: every content-changing rebuild produces a new identity and invalidates Accessibility and Screen Recording grants.

### Check the signing setup

```bash
pnpm --filter @termes/desktop-connector setup:macos:signing
```

This verifies that a valid `Termes Connector Local Development` code-signing identity is available. It deliberately does not create or export private keys, generate PEM/PKCS#12 files, or accept a Keychain password on the command line.

If the identity is absent, provision an Apple Development or Developer ID Application identity. For a local-only identity, use Keychain Access → Certificate Assistant → Create a Certificate, select **Self Signed Root** and **Code Signing**, store it in the Login Keychain, and set Code Signing trust to **Always Trust**. Then run the command again.

Set `TERMES_MACOS_SIGNING_IDENTITY` to an explicitly provisioned Apple Development or Developer ID Application identity when one is available. Ad-hoc `-` is rejected.

### Build and install updates

```bash
pnpm --filter @termes/desktop-connector install:macos:test
```

The command:

1. builds the Tauri `.app`;
2. signs it with the stable identity;
3. verifies the bundle signature and designated requirement;
4. copies the signed bundle to a private staging directory under `/Applications` and verifies it there;
5. stops the installed Connector cleanly;
6. backs up the previous fixed-path installation and replaces it with the staged bundle;
7. verifies that the installed designated requirement matches the built bundle;
8. relaunches the installed app, rolling back and restoring the prior running installation if replacement or launch fails.

The installer does not reset or modify TCC records. Do not re-sign the installed app afterward.

### First stable installation

After installing with the stable identity for the first time, manually enable `/Applications/Termes Connector.app` in:

- System Settings → Privacy & Security → Accessibility
- System Settings → Privacy & Security → Screen & System Audio Recording

Return to the Connector and refresh its permission state. Restart the unchanged app and verify that the grants persist. Future local test updates installed through `install:macos:test` retain the same designated requirement and should not require permission re-approval.

The local identity is suitable only for this Mac's test installation. Production distribution still requires a consistently provisioned Developer ID identity and notarization.
