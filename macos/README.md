# Mischief for macOS

Phase 1 is a diagnostic prototype, not a client for real Projects or Threads. See the [plan](../docs/macos-app-plan.md) and [architecture decision](../docs/adr/0002-macos-shell-webview-host.md).

The Phase 1 diagnostic prototype is in this directory. It reads no profiles or Threads and opens no network port.

## Build and check

Requires an arm64 Mac, Xcode at `/Applications/Xcode.app`, pnpm, an Apple Development signing identity in the keychain, and internet access to download the pinned Node 22 arm64 archive from nodejs.org. The Node download is SHA-256 checked against Node's published SHASUMS. Build outputs and the download cache are ignored by Git.

To use Xcode, first run `pnpm install` at the repo root, then open `macos/Mischief.xcodeproj`, choose the **Mischief** scheme and **My Mac**, and press Run (⌘R). The project uses the development team available on this machine; change the target's Signing & Capabilities team if using another account. Xcode builds and signs the app and bundled Node; edits to the React page and Host are included on the next build. The command-line build below remains available; it sets `DEVELOPER_DIR` only for its own process, without changing `xcode-select`.

```sh
pnpm install
pnpm --dir macos typecheck
pnpm --dir macos build                   # SIGN_IDENTITY='Apple Development: Name (TEAM)' to disambiguate
pnpm --dir macos test                    # exercises the signed Host and close/reopen lifecycle
codesign --verify --strict --deep --verbose=2 macos/dist/Mischief.app
open macos/dist/Mischief.app
```

## Packaged-app manual gate

1. Confirm the window shows the React diagnostic screen, Host `running` and a PID. Toggle the badge on and off; confirm the Dock icon changes and the page round-trips the badge value.
2. Close the window (not Quit). Confirm the Host PID is still alive. Click the Dock icon; confirm one window opens with the **same** PID. Repeat to check no second Host starts.
3. Click **Notify diagnostic view**. Observe authorization or denial on the screen. If authorized, confirm a banner appears; close the window and click the notification. Confirm it opens the window on `diagnostic`. If denied, enable notifications in System Settings and retry.
4. With the window open, `kill <Host PID>` from a terminal. Confirm `stopped` appears and **Restart Host** starts a new PID. Check that badge state clears on exit.
5. Quit via ⌘Q. Confirm neither the app nor its child PID remains (e.g. `ps -p <Host PID>`). Reopen the `.app` to confirm a fresh Host starts.

**Observed on this machine:** Apple Development signature verified, both packaged executables are arm64, bundled Node starts, the Host round-trip and automated window close/reopen tests pass, `open` launched one app and one Host child, and AppleScript Quit removed both. Manual testing confirmed the diagnostic page, badge changes, notification permission and click routing to the view. macOS initially muted banners while the display was shared; the notifications appeared in Notification Center. Manual testing of the Xcode-built, development-signed app also confirmed Dock-click reopen retained the same Host PID, killing the Host exposed the stopped state and allowed restart, and ⌘Q left no Host child (`ps -p <Host PID>` showed no process). **Decision: go for Phase 2.** This validates the diagnostic app shape, not a release build; Developer ID signing, notarization, and product behavior remain later work.
