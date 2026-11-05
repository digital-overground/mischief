import AppKit
import WebKit
import UserNotifications

private func installHost() throws -> URL {
    let files = FileManager.default
    let root: URL
    if let override = ProcessInfo.processInfo.environment["MISCHIEF_HOST_INSTALL_ROOT"] {
        guard override.hasPrefix("/") else { throw CocoaError(.fileWriteInvalidFileName) }
        root = URL(fileURLWithPath: override, isDirectory: true)
    } else {
        root = try files.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("Mischief/Host", isDirectory: true)
    }
    try files.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let attributes = try files.attributesOfItem(atPath: root.path)
    guard attributes[.type] as? FileAttributeType == .typeDirectory,
          (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid() else {
        throw CocoaError(.fileWriteNoPermission)
    }
    try files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)

    guard let resources = Bundle.main.resourceURL else { throw CocoaError(.fileNoSuchFile) }
    let staging = root.deletingLastPathComponent().appendingPathComponent(".Host.\(UUID().uuidString).staged", isDirectory: true)
    defer { try? files.removeItem(at: staging) }
    try files.createDirectory(at: staging, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    for (name, permissions) in [("node", 0o700), ("Host.mjs", 0o600)] {
        let destination = staging.appendingPathComponent(name)
        try files.copyItem(at: resources.appendingPathComponent(name), to: destination)
        try files.setAttributes([.posixPermissions: permissions], ofItemAtPath: destination.path)
    }
    if files.fileExists(atPath: root.path) {
        _ = try files.replaceItemAt(root, withItemAt: staging)
    } else {
        try files.moveItem(at: staging, to: root)
    }
    return root
}

private func runLaunchctl(_ arguments: [String]) throws -> Int32 {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    process.arguments = arguments
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    return process.terminationStatus
}

private func startBackgroundHost(_ host: URL) throws {
    if ProcessInfo.processInfo.environment["MISCHIEF_DISABLE_BACKGROUND_HOST"] == "1" { return }
    let environment = ProcessInfo.processInfo.environment
    let label = environment["MISCHIEF_HOST_JOB_LABEL"] ?? "works.digitaloverground.mischief.host"
    let domain = "gui/\(getuid())"
    let service = "\(domain)/\(label)"
    let files = FileManager.default
    let plist: URL
    if let override = environment["MISCHIEF_HOST_LAUNCH_AGENT_PATH"] {
        guard override.hasPrefix("/") else { throw CocoaError(.fileWriteInvalidFileName) }
        plist = URL(fileURLWithPath: override)
    } else {
        plist = files.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }
    try files.createDirectory(at: plist.deletingLastPathComponent(), withIntermediateDirectories: true)
    var hostEnvironment: [String: String] = [:]
    for name in ["MISCHIEF_HOST_SOCKET", "MISCHIEF_PROFILE_DB"] {
        if let value = environment[name] { hostEnvironment[name] = value }
    }
    let job: [String: Any] = [
        "EnvironmentVariables": hostEnvironment,
        "KeepAlive": false,
        "Label": label,
        "ProcessType": "Background",
        "ProgramArguments": [host.appendingPathComponent("node").path, host.appendingPathComponent("Host.mjs").path, "--daemon"],
        "RunAtLoad": false,
        "StandardErrorPath": host.appendingPathComponent("Host.log").path,
        "StandardOutPath": "/dev/null",
        "Umask": 0o077,
        "WorkingDirectory": host.path,
    ]
    let data = try PropertyListSerialization.data(fromPropertyList: job, format: .xml, options: 0)
    try data.write(to: plist, options: .atomic)
    try files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: plist.path)
    if try runLaunchctl(["print", service]) != 0 {
        let bootstrapped = try runLaunchctl(["bootstrap", domain, plist.path]) == 0
        if !bootstrapped {
            guard try runLaunchctl(["print", service]) == 0 else { throw CocoaError(.executableLoad) }
        }
    }
    guard try runLaunchctl(["kickstart", service]) == 0 else { throw CocoaError(.executableLoad) }
}

private struct LibraryThread: Decodable {
    let id: String
    let name: String
    let status: String
    let unread: Bool
    let updatedAt: String
}

private struct LibraryWorkspace: Decodable {
    let path: String
    let projectRoot: String?
    let name: String
    let threads: [LibraryThread]
}

private struct HostMessage: Decodable {
    let type: String
    let pid: Int?
    let badge: Int?
    let view: String?
    let workspaces: [LibraryWorkspace]?
    let attention: Int?
    let workspace: String?
    let path: String?
    let threadId: String?
}

final class App: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate, UNUserNotificationCenterDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var host: Process?
    private var input: FileHandle?
    private var pid: Int?
    private var badge = 0
    private var view = "home"
    private var permission = "checking"
    private var quitting = false
    private var library: HostMessage?
    private var pendingSelection: (String, String)?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        let menu = NSMenu()
        let app = NSMenuItem()
        app.submenu = NSMenu()
        app.submenu?.addItem(withTitle: "Quit Mischief", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(app)
        NSApp.mainMenu = menu
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                self.permission = self.permissionName(settings.authorizationStatus)
                self.updatePage()
            }
        }
        do {
            let installed = try installHost()
            try startBackgroundHost(installed)
        } catch {
            permission = "Background Host failed: \(error.localizedDescription)"
        }
        startHost()
        openWindow()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        openWindow()
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        quitting = true
        if let host = host, host.isRunning {
            host.terminate()
            host.waitUntilExit()
        }
        input?.closeFile()
    }

    func windowWillClose(_ notification: Notification) {
        guard let closing = notification.object as? NSWindow else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, self.window === closing else { return }
            self.webView?.configuration.userContentController.removeScriptMessageHandler(forName: "diagnostic")
            self.webView = nil
            self.window = nil
        }
    }

    private func openWindow() {
        if let window {
            window.makeKeyAndOrderFront(nil)
        } else {
            let config = WKWebViewConfiguration()
            config.userContentController.add(self, name: "diagnostic")
            let web = WKWebView(frame: .zero, configuration: config)
            web.navigationDelegate = self
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 680, height: 380), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            window.title = "Mischief diagnostic"
            window.isReleasedWhenClosed = false
            window.center()
            window.contentView = web
            window.delegate = self
            self.window = window
            self.webView = web
            let page = Bundle.main.resourceURL!.appendingPathComponent("index.html")
            web.loadFileURL(page, allowingReadAccessTo: Bundle.main.resourceURL!)
            window.makeKeyAndOrderFront(nil)
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        updatePage()
        updateLibrary()
        updateSelection()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: String], body["type"] == "command", let action = body["action"] else { return }
        switch action {
        case "restart":
            if host?.isRunning != true { startHost() }
            updatePage()
        case "notify", "refresh":
            send(["type": "command", "action": action])
        case "addWorkspace":
            let panel = NSOpenPanel()
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.begin { response in
                if response == .OK, let path = panel.url?.path {
                    self.send(["type": "command", "action": "addWorkspace", "path": path])
                }
            }
        case "deactivateWorkspace":
            guard let path = body["path"], library?.workspaces?.contains(where: { $0.path == path }) == true else { return }
            send(["type": "command", "action": action, "path": path])
        case "openWorkspace", "openThread":
            guard let path = body["path"], library?.workspaces?.contains(where: { $0.path == path }) == true else { return }
            if action == "openThread" {
                guard let threadId = body["threadId"], library?.workspaces?.contains(where: { $0.path == path && $0.threads.contains(where: { $0.id == threadId }) }) == true else { return }
                send(["type": "command", "action": action, "path": path, "threadId": threadId])
            } else {
                send(["type": "command", "action": action, "path": path])
            }
        default: break
        }
    }

    private func startHost() {
        guard host?.isRunning != true else { return }
        let process = Process()
        process.executableURL = Bundle.main.resourceURL!.appendingPathComponent("node")
        process.arguments = [Bundle.main.resourceURL!.appendingPathComponent("Host.mjs").path]
        let stdin = Pipe()
        let stdout = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = FileHandle.standardError
        do {
            try process.run()
        } catch {
            permission = "Host launch failed: \(error.localizedDescription)"
            updatePage()
            return
        }
        host = process
        input = stdin.fileHandleForWriting
        pid = nil
        process.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async {
                guard let self, self.host === finished, !self.quitting else { return }
                self.pid = nil
                self.badge = 0
                NSApp.dockTile.badgeLabel = nil
                self.updatePage()
            }
        }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let handle = stdout.fileHandleForReading
            var pending = Data()
            while true {
                let chunk = handle.availableData
                if chunk.isEmpty { break }
                pending.append(chunk)
                while let newline = pending.firstIndex(of: 10) {
                    let line = pending.prefix(upTo: newline)
                    pending.removeSubrange(...newline)
                    guard let message = try? JSONDecoder().decode(HostMessage.self, from: line) else { continue }
                    DispatchQueue.main.async { [weak self] in
                        guard let self, self.host === process else { return }
                        self.handle(message)
                    }
                }
            }
        }
        updatePage()
    }

    private func handle(_ message: HostMessage) {
        switch message.type {
        case "state":
            guard host?.isRunning == true, let pid = message.pid, pid == Int(host?.processIdentifier ?? -1), let badge = message.badge, badge >= 0,
                  let view = message.view, ["home", "diagnostic"].contains(view) else { return }
            self.pid = pid
            self.badge = badge
            self.view = view
            NSApp.dockTile.badgeLabel = badge == 0 ? nil : String(badge)
            updatePage()
        case "library":
            guard let attention = message.attention, attention >= 0, message.workspaces != nil else { return }
            library = message
            badge = attention
            NSApp.dockTile.badgeLabel = attention == 0 ? nil : String(attention)
            updatePage()
            updateLibrary()
        case "openWorkspace":
            guard let path = message.path, let workspace = library?.workspaces?.first(where: { $0.path == path }),
                  let code = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.microsoft.VSCode") else { return }
            NSWorkspace.shared.open([URL(fileURLWithPath: workspace.path)], withApplicationAt: code, configuration: NSWorkspace.OpenConfiguration()) { _, error in
                if let error { NSLog("Could not open VS Code: %@", error.localizedDescription) }
            }
        case "attention":
            guard let workspace = message.workspace, let threadId = message.threadId,
                  library?.workspaces?.contains(where: { $0.path == workspace && $0.threads.contains(where: { $0.id == threadId }) }) == true else { return }
            requestNotification(workspace: workspace, threadId: threadId)
        case "notify":
            guard message.view == "diagnostic" else { return }
            requestNotification()
        default: break
        }
    }

    private func send(_ message: [String: String]) {
        guard host?.isRunning == true, let data = try? JSONSerialization.data(withJSONObject: message), let input else { return }
        input.write(data + Data([10]))
    }

    private func updatePage() {
        guard let webView else { return }
        let state: [String: Any] = ["type": "state", "host": pid == nil ? "stopped" : "running", "pid": pid as Any? ?? NSNull(), "badge": badge, "view": view, "permission": permission]
        guard let data = try? JSONSerialization.data(withJSONObject: state), let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.receiveDiagnostic?.(\(json))", completionHandler: nil)
    }

    private func updateLibrary() {
        guard let webView, let library, let workspaces = library.workspaces, let attention = library.attention else { return }
        let entries: [[String: Any]] = workspaces.map { workspace in
            ["path": workspace.path, "projectRoot": workspace.projectRoot as Any? ?? NSNull(), "name": workspace.name,
             "threads": workspace.threads.map { ["id": $0.id, "name": $0.name, "status": $0.status, "unread": $0.unread, "updatedAt": $0.updatedAt] }]
        }
        let data: [String: Any] = ["type": "library", "workspaces": entries, "attention": attention]
        guard let jsonData = try? JSONSerialization.data(withJSONObject: data), let json = String(data: jsonData, encoding: .utf8) else { return }
        webView.evaluateJavaScript("if (window.receiveDiagnostic) window.receiveDiagnostic(\(json)); else window.pendingLibrary = \(json)", completionHandler: nil)
    }

    private func updateSelection() {
        guard let webView, let (workspace, threadId) = pendingSelection else { return }
        webView.evaluateJavaScript("window.pendingThreadId = \(jsonString(threadId)); window.selectThread?.(\(jsonString(workspace)), \(jsonString(threadId)))", completionHandler: nil)
        pendingSelection = nil
    }

    private func jsonString(_ text: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [text])
        return String(data: data, encoding: .utf8)!.dropFirst().dropLast().description
    }

    func verifyLibraryLoaded() {
        let probe = """
            window.libraryReady === true &&
            getComputedStyle(document.body).fontFamily.includes('IBM Plex Sans') &&
            getComputedStyle(document.querySelector('.count')).fontFamily.includes('Lilex') &&
            document.fonts.check('13px "IBM Plex Sans"') &&
            document.fonts.check('11px "Lilex"')
            """
        webView?.evaluateJavaScript(probe) { result, _ in
            if result as? Bool == true { NSApp.terminate(nil) } else { exit(1) }
        }
    }

    private func permissionName(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .authorized, .provisional, .ephemeral: "authorized"
        case .denied: "denied (enable in System Settings)"
        case .notDetermined: "not requested"
        @unknown default: "unknown"
        }
    }

    private func requestNotification(workspace: String? = nil, threadId: String? = nil) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            DispatchQueue.main.async {
                self.permission = error?.localizedDescription ?? (granted ? "authorized" : "denied (enable in System Settings)")
                self.updatePage()
                guard granted else { return }
                let content = UNMutableNotificationContent()
                let target = self.library?.workspaces?.first(where: { $0.path == workspace })
                content.title = target?.threads.first(where: { $0.id == threadId })?.name ?? "Mischief diagnostic"
                content.body = target == nil ? "Open the diagnostic view" : "Thread needs attention in \(target?.name ?? "Workspace")"
                if let workspace, let threadId {
                    content.userInfo = ["workspace": workspace, "threadId": threadId]
                } else {
                    content.userInfo = ["view": "diagnostic"]
                }
                center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)) { error in
                    if let error { NSLog("Notification failed: %@", error.localizedDescription) }
                }
            }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        DispatchQueue.main.async {
            let info = response.notification.request.content.userInfo
            if info["view"] as? String == "diagnostic" {
                self.openWindow()
                self.send(["type": "command", "action": "navigate", "view": "diagnostic"])
            } else if let workspace = info["workspace"] as? String, let threadId = info["threadId"] as? String {
                self.pendingSelection = (workspace, threadId)
                self.openWindow()
                self.updateSelection()
                if self.library?.workspaces?.contains(where: { $0.path == workspace && $0.threads.contains(where: { $0.id == threadId }) }) == true {
                    self.send(["type": "command", "action": "openThread", "path": workspace, "threadId": threadId])
                }
            }
            completionHandler()
        }
    }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
if ProcessInfo.processInfo.arguments.contains("--smoke-library") {
    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { delegate.verifyLibraryLoaded() }
}
if ProcessInfo.processInfo.arguments.contains("--smoke-install-host") || ProcessInfo.processInfo.arguments.contains("--smoke-launch-host") {
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { app.terminate(nil) }
}
if ProcessInfo.processInfo.arguments.contains("--smoke-close") {
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
        guard let window = NSApp.windows.first else { fatalError("Diagnostic window did not open") }
        window.performClose(nil)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
        precondition(!NSApp.windows.contains(where: \.isVisible), "Window remained visible after close")
        _ = delegate.applicationShouldHandleReopen(app, hasVisibleWindows: false)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
        precondition(NSApp.windows.contains(where: \.isVisible), "Window did not reopen")
        app.terminate(nil)
    }
}
app.run()
