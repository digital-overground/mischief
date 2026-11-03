# Mischief for macOS

Phase 1 proved the diagnostic app shape; Phase 2 is building a read-mostly companion for real Projects, Workspaces, and Threads. See the [plan](../docs/macos-app-plan.md) and [architecture decision](../docs/adr/0002-macos-shell-webview-host.md).

Phase 1 validated the packaged shell. The companion Host reads Workspace and Thread summaries from the Default VS Code profile and opens no network port. VS Code still owns live Threads. Both clients use `shared/theme/tokens.css`, the bundled IBM Plex Sans and Lilex fonts in `shared/theme/fonts/`, and the React icons in `shared/icons/icon.tsx`. The fonts' OFL licenses are included with the font files. macOS-specific layout lives in `macos/app.css`; theme CSS and font files are copied into both packaged apps on build.

## Build and check

Requires an arm64 Mac, Xcode at `/Applications/Xcode.app`, pnpm, an Apple Development signing identity in the keychain, and internet access to download the pinned Node 22 arm64 archive from nodejs.org. The Node download is SHA-256 checked against Node's published SHASUMS. Build outputs and the download cache are ignored by Git.

To use Xcode, first run `pnpm install` at the repo root, then open `macos/Mischief.xcodeproj`, choose the **Mischief** scheme and **My Mac**, and press Run (⌘R). The project uses the development team available on this machine; change the target's Signing & Capabilities team if using another account. Xcode builds and signs the app and bundled Node; edits to the React page and Host are included on the next build. The command-line build below remains available; it sets `DEVELOPER_DIR` only for its own process, without changing `xcode-select`.

```sh
pnpm install
pnpm --dir macos format:check             # shared extension Ultracite/Oxfmt config
pnpm --dir macos lint                     # shared extension Ultracite/Oxlint config
pnpm --dir macos typecheck
pnpm --dir macos build                   # SIGN_IDENTITY='Apple Development: Name (TEAM)' to disambiguate
pnpm --dir macos test                    # exercises the signed Host and close/reopen lifecycle
codesign --verify --strict --deep --verbose=2 macos/dist/Mischief.app
open macos/dist/Mischief.app
# or run pnpm --dir macos check for the full macOS gate
```

Oxlint and Oxfmt cover macOS TypeScript/TSX using the same Ultracite configurations as the extension; `swift-format` is separate and Oxlint does not parse Swift. Root `pnpm check` includes the macOS format, lint, and typecheck checks; packaged-app tests require macOS and a signing identity.

## Phase 2 companion check

Manual Xcode run against the Default VS Code profile confirmed: correct Project/Workspace/Thread grouping; opening the correct Workspace and Thread in VS Code; adding and deactivating a disposable Workspace in both clients; an accurate Dock count and one notification when a Thread newly needs attention; clicking that notification with the app window closed reopened the app and selected the Thread in VS Code; restarting with pre-existing attention restored the count without another notification. Automated build, signing, lint, typecheck, and tests also pass.

**Decision: go for Phase 2.** For this companion release, Deactivate hides the Workspace record but deliberately leaves any already-open VS Code window open. It is not equivalent to the extension's Close Workspace action. The macOS app still does not own live Threads; that transition belongs to Phase 3.

## Phase 1 packaged-app gate (passed)

1. The original diagnostic screen showed Host `running` and a PID and could toggle the badge. Phase 2 uses the badge for real Thread attention instead of a manual toggle.
2. Close the window (not Quit). Confirm the Host PID is still alive. Click the Dock icon; confirm one window opens with the **same** PID. Repeat to check no second Host starts.
3. Click **Notify diagnostic view**. Observe authorization or denial on the screen. If authorized, confirm a banner appears; close the window and click the notification. Confirm it opens the window on `diagnostic`. If denied, enable notifications in System Settings and retry.
4. With the window open, `kill <Host PID>` from a terminal. Confirm `stopped` appears and **Restart Host** starts a new PID. Check that badge state clears on exit.
5. Quit via ⌘Q. Confirm neither the app nor its child PID remains (e.g. `ps -p <Host PID>`). Reopen the `.app` to confirm a fresh Host starts.

**Observed on this machine:** Apple Development signature verified, both packaged executables are arm64, bundled Node starts, the Host round-trip and automated window close/reopen tests pass, `open` launched one app and one Host child, and AppleScript Quit removed both. Manual testing confirmed the diagnostic page, badge changes, notification permission and click routing to the view. macOS initially muted banners while the display was shared; the notifications appeared in Notification Center. Manual testing of the Xcode-built, development-signed app also confirmed Dock-click reopen retained the same Host PID, killing the Host exposed the stopped state and allowed restart, and ⌘Q left no Host child (`ps -p <Host PID>` showed no process). **Decision: go for Phase 2.** This validates the diagnostic app shape, not a release build; Developer ID signing, notarization, and product behavior remain later work.
