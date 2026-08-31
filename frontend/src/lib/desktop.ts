/**
 * The bridge to the native macOS shell.
 *
 * desktop/Optimus.swift is an AppKit window around this page, and it installs a
 * WKScriptMessageHandler named "optimus". When the page is open anywhere else
 * -- a browser tab, the Fly deployment -- the handler is simply absent, so
 * every call here is a no-op rather than a feature that half-works.
 *
 * What crosses the bridge is the FACT of a session, not a tick: the native side
 * is given started_at and planned_minutes and runs its own clock. A page that
 * is minimised gets throttled to once a minute or stopped altogether, and a
 * menu-bar timer driven from here would visibly freeze at exactly the moment it
 * became the only timer on screen.
 */

interface Bridge {
  postMessage(message: unknown): void;
}

declare global {
  interface Window {
    webkit?: { messageHandlers?: { optimus?: Bridge } };
  }
}

export type DesktopMessage =
  /* Epoch milliseconds, not the ISO string the API returns. Python writes
     microsecond precision and a +00:00 offset, and Foundation's ISO-8601 parser
     is fussy about exactly that shape -- the browser has already parsed it
     correctly, so it may as well hand over a number. */
  | { type: "session:start"; startedAtMs: number; plannedMinutes: number; title: string }
  | { type: "session:end" }
  | { type: "pill:show" }
  | { type: "pill:hide" };

/** Event names the native shell may dispatch into the page. */
export const NATIVE_EVENTS = {
  openSessionLog: "optimus:open-session-log",
} as const;

/** Whether the page is running inside the native shell. */
export function onDesktop(): boolean {
  return typeof window !== "undefined" && !!window.webkit?.messageHandlers?.optimus;
}

export function tellDesktop(message: DesktopMessage): void {
  try {
    window.webkit?.messageHandlers?.optimus?.postMessage(message);
  } catch {
    // The bridge is a nicety. Losing it must never take the session with it.
  }
}

/**
 * Announce that the planned time is up.
 *
 * Native handles this itself -- it owns the clock and can raise a notification
 * whether or not this page is even being rendered -- so this only covers the
 * browser, where the Web Notification API exists. WKWebView has no
 * implementation of it at all, which is why the native path is not optional.
 */
export function announceComplete(title: string): void {
  if (onDesktop()) return;
  if (typeof Notification === "undefined") return;
  const show = () => {
    if (Notification.permission !== "granted") return;
    new Notification("Session complete", {
      body: `${title} — still going counts as flow.`,
      tag: "optimus-session",
    });
  };
  if (Notification.permission === "default") {
    void Notification.requestPermission().then(show);
    return;
  }
  show();
}
