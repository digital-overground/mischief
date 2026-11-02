# Mischief for macOS

Phase 1 is a diagnostic prototype, not a client for real Projects or Threads. See the [plan](../docs/macos-app-plan.md) and [architecture decision](../docs/adr/0002-macos-shell-webview-host.md).

The first implementation task is to produce a packaged, Apple Development-signed arm64 `.app` with a bundled React page and Node runtime. Swift launches the diagnostic Host over standard input/output. Keep window close/reopen separate from Quit, and test the signed app end to end before moving any product behavior.

On this development machine Xcode is installed, but `xcode-select` currently points to Command Line Tools. Build instructions should select Xcode explicitly without requiring a permanent machine-wide change. Do not check in signing credentials or derived build artifacts.
