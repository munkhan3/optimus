/**
 * Setting up a session, from anywhere in the app.
 *
 * The trigger lives in the shell's chrome — the rail footer beside Ask Anything
 * on desktop, the header on a phone — so starting work is reachable from every
 * view without a button hovering over whatever is being read.
 *
 * The panel itself is a modal, and deliberately so. It was a popover anchored to
 * its trigger, which had two problems: the rail is 248px and the panel is wider,
 * so it had to open rightward over the content or hang off the screen; and both
 * mounts sit inside `position: fixed`/`sticky` ancestors, each of which creates
 * a stacking context the panel could not escape — so it rendered *under* the
 * mobile tab bar and the session bar no matter what z-index it claimed.
 *
 * Rendering into document.body through a portal fixes that at the root rather
 * than by escalating numbers, and a scrim over everything else matches what this
 * moment is: the one decision on screen.
 *
 * Layout is fixed head, scrolling middle, fixed foot. Only the trackable list
 * scrolls — the duration presets and the commit button stay put, because
 * scrolling to reach the button you are about to press is the failure mode a
 * long list produces.
 *
 * Hidden while a session runs: SessionBar is the timer then, and two live
 * timers on one screen is exactly the ambiguity this app avoids elsewhere.
 */

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { api, ApiError } from "../lib/api";
import type { TrackableView } from "../lib/types";
import { Banner, Button, SectionLabel } from "./Primitives";
import { SessionDuration, useSessionDefaults } from "./SessionDuration";
import { TrackablePicker } from "./TrackablePicker";

export function StartSession({
  trackables,
  onStarted,
  disabled,
  className = "",
  children,
}: {
  trackables: TrackableView[];
  onStarted: () => void;
  disabled?: boolean;
  className?: string;
  /** The trigger's own content, so the rail can look like a rail item and the
      header like a header control. */
  children: ReactNode;
}) {
  const { minutes: defaultMinutes } = useSessionDefaults();
  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState(defaultMinutes);
  const [target, setTarget] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The default arrives after the first render, once /defaults resolves. Only
  // adopt it while the user has not chosen, or reopening the panel would
  // silently discard their choice.
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setMinutes(defaultMinutes);
  }, [defaultMinutes]);

  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", esc);
    // The page behind must not scroll under the scrim; on a phone that reads as
    // the dialog itself being broken.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", esc);
      document.body.style.overflow = previous;
    };
  }, [open]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/sessions/start", {
        planned_minutes: minutes,
        ...(target !== null ? { trackable_id: target } : {}),
      });
      setOpen(false);
      onStarted();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const chosen = trackables.find((t) => t.trackable_id === target);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`w-full ${className}`}
      >
        {children}
      </button>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-label="Set up a session"
          >
            {/* The scrim is the point: this is one decision, and everything
                behind it can wait. Clicking it is the expected way out. */}
            <button
              aria-label="Close"
              onClick={() => setOpen(false)}
              className="absolute inset-0 cursor-default bg-void/75 backdrop-blur-sm"
            />

            <div className="relative flex max-h-[85dvh] w-[min(22rem,100%)] flex-col rounded-card border border-line bg-surface shadow-2xl">
              {/* ---- fixed head ---------------------------------------- */}
              <div className="shrink-0 p-5 pb-4">
                {error && (
                  <div className="mb-3">
                    <Banner>{error}</Banner>
                  </div>
                )}
                <SectionLabel>Focus Time</SectionLabel>
                <div className="mt-2">
                  <SessionDuration
                    value={minutes}
                    onChange={(m) => {
                      touched.current = true;
                      setMinutes(m);
                    }}
                    disabled={busy}
                  />
                </div>
              </div>

              {/* ---- the only thing that scrolls ----------------------- */}
              <div className="min-h-0 flex-1 overflow-y-auto border-y border-line px-5 py-4">
                <SectionLabel>Working On</SectionLabel>
                <div className="mt-1.5">
                  <TrackablePicker
                    trackables={trackables}
                    selectedId={target}
                    onSelect={setTarget}
                    disabled={busy}
                  />
                </div>
              </div>

              {/* ---- fixed foot ---------------------------------------- */}
              <div className="shrink-0 p-5 pt-4">
                <Button className="w-full" pending={busy} disabled={busy} onClick={start}>
                  Start {minutes}m
                  {chosen ? ` · ${truncate(chosen.title)}` : " · Untracked"}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/** The button has one line; a long trackable title would push the length off it. */
function truncate(title: string): string {
  return title.length > 18 ? `${title.slice(0, 17)}…` : title;
}
