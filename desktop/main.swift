// The entry point, and nothing else.
//
// Swift only permits top-level statements in a file called main.swift, and this
// app is no longer one file: the session HUD lives in SessionHUD.swift. So the
// five lines that actually start the process moved here, and Optimus.swift went
// back to being only declarations.

import Cocoa

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
// A regular app, not an accessory: the menu-bar timer is somewhere the session
// ALSO appears when the window is away, not a replacement for having a window.
app.setActivationPolicy(.regular)
app.run()
