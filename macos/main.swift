import AppKit
import WebKit
import UserNotifications

private struct HostMessage: Decodable {
    let type: String
    let pid: Int?
    let badge: Int?
    let view: String?
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

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { updatePage() }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: String], body["type"] == "command", let action = body["action"] else { return }
        switch action {
        case "restart":
            if host?.isRunning != true { startHost() }
            updatePage()
        case "badge", "notify":
            send(["type": "command", "action": action])
        default: break
        }
    }

    private func startHost() {
        guard host?.isRunning != true else { return }
        let process = Process()
        process.executableURL = Bundle.main.resourceURL!.appendingPathComponent("node")
        process.arguments = [Bundle.main.resourceURL!.appendingPathComponent("Host.js").path]
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

    private func permissionName(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .authorized, .provisional, .ephemeral: "authorized"
        case .denied: "denied (enable in System Settings)"
        case .notDetermined: "not requested"
        @unknown default: "unknown"
        }
    }

    private func requestNotification() {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            DispatchQueue.main.async {
                self.permission = error?.localizedDescription ?? (granted ? "authorized" : "denied (enable in System Settings)")
                self.updatePage()
                guard granted else { return }
                let content = UNMutableNotificationContent()
                content.title = "Mischief diagnostic"
                content.body = "Open the diagnostic view"
                content.userInfo = ["view": "diagnostic"]
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
            if response.notification.request.content.userInfo["view"] as? String == "diagnostic" {
                self.openWindow()
                self.send(["type": "command", "action": "navigate", "view": "diagnostic"])
            }
            completionHandler()
        }
    }
}]

let app = NSApplication.shared]
let delegate = App()
app.delegate = delegate
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
