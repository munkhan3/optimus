// The session, outside the window.
//
// A countdown is only useful while you are looking at it, and the whole point
// of a focus session is that you are looking at something else. So the timer
// gets two homes the web view cannot provide: a floating pill that sits above
// every other window, and -- once you dismiss the pill, or minimise the app --
// a line in the menu bar next to the clock.
//
// The native side keeps its own clock rather than being fed ticks. WebKit
// throttles timers in a minimised or occluded view down to once a minute and
// sometimes stops them outright, so a menu-bar countdown driven from the page
// would freeze at exactly the moment it became the only countdown on screen.
// The page therefore sends the FACT of a session -- when it started, how long
// it was meant to be -- and nothing after that.

import Cocoa
import UserNotifications

// ---------------------------------------------------------------- the session

struct SessionInfo {
    let startedAt: Date
    let plannedMinutes: Int
    let title: String

    /// Seconds left. Negative once the planned time has been used up, which is
    /// the interesting half: the session did not fail to end, the user chose
    /// not to stop.
    var remaining: TimeInterval {
        startedAt.addingTimeInterval(Double(plannedMinutes) * 60).timeIntervalSinceNow
    }

    var overtime: Bool { remaining < 0 }

    /// M:SS, prefixed with + once past the boundary. Matches the web UI exactly;
    /// two timers for one session must never disagree by a second.
    var clock: String {
        let total = Int(abs(remaining).rounded(.down))
        return String(format: "%@%d:%02d", overtime ? "+" : "", total / 60, total % 60)
    }
}

// -------------------------------------------------------------------- palette

private let INK = NSColor(srgbRed: 0.961, green: 0.961, blue: 0.969, alpha: 1)
private let MUTED = NSColor(srgbRed: 0.62, green: 0.62, blue: 0.63, alpha: 1)
private let IRIS = NSColor(srgbRed: 0.518, green: 0.490, blue: 1.0, alpha: 1)
private let SURFACE = NSColor(srgbRed: 0.102, green: 0.106, blue: 0.110, alpha: 0.96)
private let LINE = NSColor(srgbRed: 0.247, green: 0.251, blue: 0.255, alpha: 1)

// ------------------------------------------------------------------- the pill

/// A borderless panel, because a title bar on a 44pt strip is most of the strip.
/// `.nonactivatingPanel` keeps clicking it from stealing focus from whatever the
/// user is actually working in, which is the entire reason it floats.
final class PillWindow: NSPanel {
    private let clock = NSTextField(labelWithString: "0:00")
    private let name = NSTextField(labelWithString: "")
    private let finish = NSButton(title: "Finish", target: nil, action: nil)
    private let close = NSButton(title: "✕", target: nil, action: nil)

    init(onFinish: @escaping () -> Void, onClose: @escaping () -> Void) {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 320, height: 52),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)

        isFloatingPanel = true
        level = .floating
        // Follows the user across spaces and sits over a full-screen app: a
        // timer that only exists on desktop 1 is not a timer.
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        backgroundColor = .clear
        isOpaque = false
        hasShadow = true
        isMovableByWindowBackground = true
        hidesOnDeactivate = false

        let body = NSView()
        body.wantsLayer = true
        body.layer?.backgroundColor = SURFACE.cgColor
        body.layer?.cornerRadius = 26
        body.layer?.borderWidth = 1
        body.layer?.borderColor = LINE.cgColor

        clock.font = .monospacedDigitSystemFont(ofSize: 17, weight: .medium)
        clock.textColor = INK
        name.font = .systemFont(ofSize: 11)
        name.textColor = MUTED
        name.lineBreakMode = .byTruncatingTail

        for button in [finish, close] {
            button.bezelStyle = .inline
            button.isBordered = false
            button.contentTintColor = MUTED
        }
        finish.font = .systemFont(ofSize: 11, weight: .medium)
        close.font = .systemFont(ofSize: 13)

        finishBox = ClickBox(onFinish)
        finish.target = finishBox
        finish.action = #selector(ClickBox.fire)
        closeBox = ClickBox(onClose)
        close.target = closeBox
        close.action = #selector(ClickBox.fire)

        let text = NSStackView(views: [clock, name])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 1

        let row = NSStackView(views: [text, finish, close])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 12
        row.edgeInsets = NSEdgeInsets(top: 0, left: 18, bottom: 0, right: 14)
        row.setHuggingPriority(.defaultLow, for: .horizontal)
        text.setContentHuggingPriority(.defaultLow, for: .horizontal)

        body.addSubview(row)
        row.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: body.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: body.trailingAnchor),
            row.centerYAnchor.constraint(equalTo: body.centerYAnchor),
        ])
        contentView = body
    }

    /// NSControl.target is weak, so the handlers have to be owned here or the
    /// buttons compile fine and then silently do nothing.
    private var finishBox: ClickBox?
    private var closeBox: ClickBox?

    func show(_ info: SessionInfo) {
        clock.stringValue = info.clock
        clock.textColor = info.overtime ? IRIS : INK
        name.stringValue = info.overtime ? "In flow · \(info.title)" : info.title
    }

    /// Bottom centre of the screen the user is actually on, clear of the Dock.
    func place() {
        guard let screen = NSScreen.main else { return }
        let area = screen.visibleFrame
        setFrameOrigin(NSPoint(
            x: area.midX - frame.width / 2,
            y: area.minY + 24))
    }
}

final class ClickBox: NSObject {
    private let run: () -> Void
    init(_ run: @escaping () -> Void) { self.run = run }
    @objc func fire() { run() }
}

// -------------------------------------------------------------------- the HUD

final class SessionHUD: NSObject {
    /// Bring the main window forward. Ending a metered session takes one
    /// prefilled input (§23.2), and that input lives in one place -- so every
    /// route to "I'm done" leads back to the app rather than growing a second
    /// copy of the form in a 52pt panel.
    var onOpenApp: () -> Void = {}

    private var info: SessionInfo?
    private var ticker: Timer?
    private var pill: PillWindow?
    private var status: NSStatusItem?
    /// On screen right now. The pill is the primary surface once you leave the
    /// app, so nothing else needs to speak for the session while it is up.
    private var pillVisible = false
    /// Closed with the ✕, which is the user asking for the menu bar instead.
    /// Reset per session rather than remembered forever: starting the next one
    /// should offer the pill again, not silently withhold it.
    private var pillDismissed = false
    private var announced = false
    private var windowHidden = false
    private var notificationsReady = false

    // ------------------------------------------------------------- lifecycle

    func start(_ next: SessionInfo) {
        // The page re-announces on every refresh; only a genuinely different
        // session resets what the user has dismissed.
        let isNew = info.map { $0.startedAt != next.startedAt } ?? true
        info = next
        if isNew {
            pillDismissed = false
            announced = false
            askForNotifications()
        }

        /* No surface yet. A pill that appears the moment you press Start is
           covering the full-screen countdown it duplicates; it earns its place
           when you leave, which is when the app asks for it. */
        refreshStatusItem()

        if ticker == nil {
            let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
            // Common modes, or the countdown stops dead while a menu is open or
            // a window is being dragged.
            RunLoop.main.add(timer, forMode: .common)
            ticker = timer
        }
        tick()
    }

    func stop() {
        info = nil
        ticker?.invalidate()
        ticker = nil
        pill?.orderOut(nil)
        pill = nil
        pillVisible = false
        if let item = status { NSStatusBar.system.removeStatusItem(item) }
        status = nil
    }

    /// Minimising or hiding is the moment the menu bar earns its place.
    func setWindowHidden(_ hidden: Bool) {
        windowHidden = hidden
        refreshStatusItem()
    }

    /// Called when the app resigns active (loses focus). Show the pill if a
    /// session is running and the user has not dismissed it for this session.
    func showPillOnDeactivate() {
        guard info != nil && !pillDismissed && !pillVisible else { return }
        showPill()
    }

    /// Called when the app becomes active again. Hide the pill (the main
    /// window will show the full countdown) but do not mark it dismissed.
    func hidePillOnActivate() {
        if pillVisible {
            hidePill()
        }
    }

    // ------------------------------------------------------------------ tick

    private func tick() {
        guard let info else { return }
        pill?.show(info)
        if let button = status?.button {
            button.attributedTitle = NSAttributedString(
                string: info.clock,
                attributes: [
                    .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular),
                    .foregroundColor: info.overtime ? IRIS : NSColor.controlTextColor,
                ])
        }
        if info.overtime && !announced {
            announced = true
            announce(info)
        }
    }

    // ---------------------------------------------------------------- surfaces

    /// Put the pill up. Called when the app collapses into it, never on its own.
    func showPill() {
        guard info != nil else { return }
        if pill == nil {
            pill = PillWindow(
                onFinish: { [weak self] in self?.onOpenApp() },
                onClose: { [weak self] in self?.dismissPill() })
        }
        pillDismissed = false
        pill?.place()
        // Regardless, because the app is on its way to being minimised and an
        // ordinary orderFront would go behind whatever the user moves to next.
        pill?.orderFrontRegardless()
        pillVisible = true
        refreshStatusItem()
    }

    /// Take the pill down without treating it as dismissed -- coming back into
    /// the app, where the countdown is already on screen at full size.
    func hidePill() {
        pill?.orderOut(nil)
        pillVisible = false
        refreshStatusItem()
    }

    private func dismissPill() {
        pillDismissed = true
        pill?.orderOut(nil)
        pillVisible = false
        // Never leave a running session with nowhere to be seen: closing the
        // pill promotes the timer to the menu bar rather than losing it.
        refreshStatusItem()
    }

    /// The menu bar speaks for the session whenever the pill is not there to.
    ///
    /// Two ways to end up here: closing the pill outright, or minimising the
    /// app without ever having asked for one. Both mean the countdown has no
    /// home on screen, and a running timer with nowhere to be seen is the one
    /// state this is all arranged to prevent.
    private func refreshStatusItem() {
        let wanted = info != nil && !pillVisible && (pillDismissed || windowHidden)
        if wanted && status == nil {
            let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            let menu = NSMenu()
            menu.addItem(withTitle: "Show Timer Pill", action: #selector(showPillFromMenu),
                         keyEquivalent: "").target = self
            menu.addItem(withTitle: "Finish in Optimus…", action: #selector(openFromMenu),
                         keyEquivalent: "").target = self
            item.menu = menu
            status = item
            tick()
        } else if !wanted, let item = status {
            NSStatusBar.system.removeStatusItem(item)
            status = nil
        }
    }

    @objc private func showPillFromMenu() { showPill() }

    @objc private func openFromMenu() { onOpenApp() }

    // ----------------------------------------------------------- the alarm

    private func askForNotifications() {
        // UNUserNotificationCenter traps outright when there is no bundle
        // identifier to attribute the notification to, which is the case for a
        // bare executable run from the build directory.
        guard Bundle.main.bundleIdentifier != nil else { return }
        UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .sound]) { [weak self] granted, _ in
                DispatchQueue.main.async { self?.notificationsReady = granted }
            }
    }

    /// Say that the planned time is up, by whatever means is actually available.
    ///
    /// The fallback is not defensive padding. This bundle is ad-hoc signed, and
    /// notification authorization for such an app is routinely refused -- so on
    /// a locally built Optimus the sound and the bouncing Dock icon are the
    /// normal path, not the exceptional one.
    private func announce(_ info: SessionInfo) {
        if notificationsReady, Bundle.main.bundleIdentifier != nil {
            let body = UNMutableNotificationContent()
            body.title = "Session complete"
            body.body = "\(info.title) — still going counts as flow."
            body.sound = .default
            UNUserNotificationCenter.current().add(
                UNNotificationRequest(identifier: UUID().uuidString, content: body, trigger: nil))
        } else {
            NSSound(named: "Glass")?.play()
            NSApp.requestUserAttention(.criticalRequest)
        }
    }
}
