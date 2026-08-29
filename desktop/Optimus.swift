// A native window around the locally-served Optimus UI.
//
// Deliberately a *window*, not a bundle: the frontend is loaded over HTTP from
// the API's own static mount, so editing the repo and relaunching shows the new
// build. Nothing about the app has to be rebuilt when the product changes --
// which is the whole reason this is 300 lines of AppKit rather than a packaged
// webview framework.
//
// On launch it brings up whatever is not already running (Postgres, a stale
// frontend build, the API), reports each step, and only then shows the UI.

import Cocoa
import WebKit

let PORT = 8077
let BASE = URL(string: "http://localhost:\(PORT)")!
let HEALTH = URL(string: "http://localhost:\(PORT)/api/health")!

/// True when the built frontend is older than its sources. Vite builds this
/// project in about 100ms, so it is cheaper to check than to think about.
let STALE_CHECK = """
    if [ ! -f frontend/dist/index.html ]; then echo yes; \
    elif [ -n "$(find frontend/src frontend/index.html frontend/package.json \
         -newer frontend/dist/index.html 2>/dev/null | head -1)" ]; then echo yes; \
    else echo no; fi
    """

/// Baked in by build.sh. The app runs the repo in place; it does not copy it.
let REPO = (Bundle.main.object(forInfoDictionaryKey: "OptimusRepoRoot") as? String)
    ?? FileManager.default.currentDirectoryPath

let LOG_DIR = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/Optimus")
let API_LOG = LOG_DIR.appendingPathComponent("api.log")

// ---------------------------------------------------------------- shell

@discardableResult
func sh(_ command: String, timeout: TimeInterval = 180) -> (code: Int32, out: String) {
    let p = Process()
    // A login shell, because an app launched from Finder inherits almost no PATH
    // -- brew, uv and npm all live in places only the login shell knows about.
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")
    p.arguments = ["-lc", "cd '\(REPO)' && \(command)"]
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    do { try p.run() } catch { return (127, "could not run shell: \(error)") }

    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}

func healthOK() -> Bool {
    var ok = false
    let sem = DispatchSemaphore(value: 0)
    var req = URLRequest(url: HEALTH)
    req.timeoutInterval = 2
    URLSession.shared.dataTask(with: req) { data, resp, _ in
        if let http = resp as? HTTPURLResponse, http.statusCode == 200,
           let d = data, let s = String(data: d, encoding: .utf8), s.contains("\"ok\"") {
            ok = true
        }
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 3)
    return ok
}

// ---------------------------------------------------------------- preflight

enum Preflight {
    /// The API process this app owns, if it started one. If the API was already
    /// running when we launched, this stays nil and quitting leaves it alone --
    /// stopping a server someone else started would be rude.
    static var api: Process?

    static func run(status: @escaping (String) -> Void) throws {
        try? FileManager.default.createDirectory(at: LOG_DIR, withIntermediateDirectories: true)

        // 1. Postgres. It is a launchd agent, so normally this is a no-op --
        //    but it does stop sometimes, and the failure it produces otherwise
        //    is a 500 from /api/health with no explanation.
        status("Checking Postgres…")
        if sh("pg_isready -q", timeout: 10).code != 0 {
            status("Starting Postgres…")
            let r = sh("brew services start postgresql@17", timeout: 60)
            guard r.code == 0 else { throw Fail("Could not start Postgres.\n\n\(r.out)") }
            for _ in 0..<30 {
                if sh("pg_isready -q", timeout: 5).code == 0 { break }
                Thread.sleep(forTimeInterval: 0.5)
            }
            guard sh("pg_isready -q", timeout: 5).code == 0 else {
                throw Fail("Postgres started but never accepted connections.")
            }
        }

        // 2. Frontend. Rebuild only when something actually changed; Vite does
        //    this project in ~100ms, so the check costs more than the build.
        status("Checking Frontend…")
        let stale = sh(STALE_CHECK, timeout: 30)
        if stale.out.contains("yes") {
            status("Rebuilding Frontend…")
            let r = sh("cd frontend && npm run build", timeout: 300)
            guard r.code == 0 else { throw Fail("Frontend build failed.\n\n\(tail(r.out))") }
        }

        // 3. API.
        status("Checking API…")
        if !healthOK() {
            status("Starting API…")
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/zsh")
            p.arguments = ["-lc",
                "cd '\(REPO)' && exec uv run uvicorn optimus.api.main:app --port \(PORT) --reload"]
            FileManager.default.createFile(atPath: API_LOG.path, contents: nil)
            let handle = try FileHandle(forWritingTo: API_LOG)
            p.standardOutput = handle
            p.standardError = handle
            try p.run()
            api = p

            var up = false
            for _ in 0..<40 {
                if healthOK() { up = true; break }
                if !p.isRunning { break }
                Thread.sleep(forTimeInterval: 0.5)
            }
            guard up else {
                let log = (try? String(contentsOf: API_LOG, encoding: .utf8)) ?? ""
                throw Fail("The API did not come up.\n\n\(tail(log))")
            }
        }
        status("Ready")
    }

    static func stop() {
        guard let p = api, p.isRunning else { return }
        p.terminate()
        // exec in the zsh -lc means SIGTERM reaches uvicorn directly.
        for _ in 0..<20 where p.isRunning { Thread.sleep(forTimeInterval: 0.1) }
    }

    struct Fail: Error { let message: String; init(_ m: String) { message = m } }
    static func tail(_ s: String, _ n: Int = 24) -> String {
        s.split(separator: "\n", omittingEmptySubsequences: false).suffix(n).joined(separator: "\n")
    }
}

// ---------------------------------------------------------------- status view

/// What the window shows while the stack comes up. Uses the app's own palette so
/// launching does not flash a white panel before the dark UI arrives.
final class StatusView: NSView {
    private let label = NSTextField(labelWithString: "Starting…")
    private let detail = NSTextView()
    private let spinner = NSProgressIndicator()
    private let retry = NSButton(title: "Try Again", target: nil, action: nil)
    private let scroll = NSScrollView()
    /// NSControl.target is a *weak* reference, so the handler has to be owned
    /// here. Assigning it inline compiles and then silently does nothing.
    private var retryBox: RetryBox?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor(srgbRed: 0.059, green: 0.063, blue: 0.067, alpha: 1).cgColor

        label.font = .systemFont(ofSize: 13, weight: .medium)
        label.textColor = NSColor(srgbRed: 0.62, green: 0.62, blue: 0.63, alpha: 1)
        label.alignment = .center

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.startAnimation(nil)

        detail.isEditable = false
        detail.drawsBackground = false
        detail.font = .monospacedSystemFont(ofSize: 10, weight: .regular)
        detail.textColor = NSColor(srgbRed: 0.42, green: 0.42, blue: 0.42, alpha: 1)
        scroll.documentView = detail
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.isHidden = true

        retry.isHidden = true
        retry.bezelStyle = .rounded

        for v in [spinner, label, scroll, retry] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            addSubview(v)
        }
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -60),
            label.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 16),
            label.centerXAnchor.constraint(equalTo: centerXAnchor),
            scroll.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 16),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 40),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -40),
            scroll.heightAnchor.constraint(equalToConstant: 180),
            retry.topAnchor.constraint(equalTo: scroll.bottomAnchor, constant: 16),
            retry.centerXAnchor.constraint(equalTo: centerXAnchor),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }

    func set(_ text: String) {
        label.stringValue = text
        label.textColor = NSColor(srgbRed: 0.62, green: 0.62, blue: 0.63, alpha: 1)
    }

    func fail(_ text: String, detailText: String, onRetry: @escaping () -> Void) {
        spinner.stopAnimation(nil)
        spinner.isHidden = true
        label.stringValue = text
        label.textColor = NSColor(srgbRed: 0.93, green: 0.42, blue: 0.38, alpha: 1)
        detail.string = detailText
        scroll.isHidden = detailText.isEmpty
        retry.isHidden = false
        retryBox = RetryBox(onRetry)
        retry.target = retryBox
        retry.action = #selector(RetryBox.fire)
    }
}

final class RetryBox: NSObject {
    let fn: () -> Void
    init(_ fn: @escaping () -> Void) { self.fn = fn }
    @objc func fire() { fn() }
}

// ---------------------------------------------------------------- app

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var status: StatusView!

    func applicationDidFinishLaunching(_ n: Notification) {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Optimus"
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(srgbRed: 0.059, green: 0.063, blue: 0.067, alpha: 1)
        window.minSize = NSSize(width: 380, height: 560)
        window.setFrameAutosaveName("OptimusMain")
        window.center()

        let cfg = WKWebViewConfiguration()
        // The UI is served from localhost and is the only thing this window ever
        // loads; DevTools stay available because debugging the real app beats
        // reproducing a bug in a browser tab.
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: .zero, configuration: cfg)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        status = StatusView(frame: .zero)
        window.contentView = status
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        buildMenu()
        start()
    }

    func start() {
        window.contentView = status
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try Preflight.run { msg in DispatchQueue.main.async { self.status.set(msg) } }
                DispatchQueue.main.async { self.showWeb() }
            } catch let e as Preflight.Fail {
                let parts = e.message.split(separator: "\n\n", maxSplits: 1)
                DispatchQueue.main.async {
                    self.status.fail(String(parts.first ?? "Could not start"),
                                     detailText: parts.count > 1 ? String(parts[1]) : "") {
                        self.start()
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    self.status.fail("Could not start", detailText: "\(error)") { self.start() }
                }
            }
        }
    }

    func showWeb() {
        window.contentView = webView
        webView.load(URLRequest(url: BASE))
    }

    // ------------------------------------------------------------ lifecycle

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ n: Notification) { Preflight.stop() }

    func applicationShouldHandleReopen(_ s: NSApplication, hasVisibleWindows f: Bool) -> Bool {
        if !f { window.makeKeyAndOrderFront(nil) }
        // Clicking the icon means "show me Optimus", and the honest reading of
        // that is the current Optimus -- not the build from whenever this
        // process happened to start.
        syncAndReload()
        return true
    }

    /// Rebuild the frontend if sources moved ahead of it, then reload the view.
    /// Cheap when nothing changed: one `find`, no build, no flicker.
    private var syncing = false
    func syncAndReload() {
        guard !syncing, window.contentView === webView else { return }
        syncing = true
        DispatchQueue.global(qos: .userInitiated).async {
            let stale = sh(STALE_CHECK, timeout: 30).out.contains("yes")
            if stale {
                DispatchQueue.main.async { self.window.title = "Optimus — Rebuilding…" }
                _ = sh("cd frontend && npm run build", timeout: 300)
            }
            DispatchQueue.main.async {
                self.window.title = "Optimus"
                if stale { self.webView.reload() }
                self.syncing = false
            }
        }
    }

    // ------------------------------------------------------------ menus

    @objc func reload() { syncAndReload(); webView.reload() }
    @objc func openLogs() { NSWorkspace.shared.open(LOG_DIR) }
    @objc func openInBrowser() { NSWorkspace.shared.open(BASE) }

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Optimus", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Optimus", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Optimus", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        // Without a real Edit menu the standard responder chain never sees
        // Cmd-V, and the first thing this app asks for is a pasted token.
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        view.addItem(.separator())
        view.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "B")
        view.addItem(withTitle: "Show API Log", action: #selector(openLogs), keyEquivalent: "L")
        view.addItem(.separator())
        view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        viewItem.submenu = view
        main.addItem(viewItem)

        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
