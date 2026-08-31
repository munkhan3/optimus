import { useCallback, useEffect, useState } from "react";
import { api, ApiError, clearToken, getToken, setToken } from "./lib/api";
import type { PlanItem, TrackableView, WorkSession } from "./lib/types";
import { localDate } from "./lib/format";
import { SessionBar } from "./components/SessionBar";
import { FocusSession } from "./components/FocusSession";
import { onDesktop, tellDesktop } from "./lib/desktop";
import { Banner, Button, Card, Field } from "./components/Primitives";
import { Shell, type Tab } from "./components/Shell";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Trackables } from "./views/Trackables";
import { Today } from "./views/Today";
import { Plan } from "./views/Plan";
import { Review } from "./views/Review";
import { Tree } from "./views/Tree";
import { Assistant } from "./views/Assistant";
import { Intake } from "./views/Intake";
import { Dashboard } from "./views/Dashboard";
import { Roadmap } from "./views/Roadmap";
import { AccountPanel } from "./components/AccountPanel";
import { SessionHistory } from "./components/SessionHistory";

export default function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));
  const [tab, setTab] = useState<Tab>("dash");
  // null = not yet known. Distinguishing that from "empty" keeps the
  // intake screen from flashing before the first response lands.
  const [hasGoals, setHasGoals] = useState<boolean | null>(null);
  const [trackables, setTrackables] = useState<TrackableView[]>([]);
  const [session, setSession] = useState<WorkSession | null>(null);
  const [plan, setPlan] = useState<PlanItem[]>([]);
  const [capBinding, setCapBinding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  /* Whether the session has the whole screen. A session opens expanded --
     starting work is the moment that deserves the display -- and collapses to
     the docked bar the moment the user needs the app underneath it again. */
  const [expanded, setExpanded] = useState(true);
  const [showHistory, setShowHistory] = useState(false);

  /// Both ways out of an account land here: the token is gone, the panel
  /// closes, and the gate comes back.
  const leaveAccount = useCallback(() => {
    clearToken();
    setAccountOpen(false);
    setAuthed(false);
  }, []);

  const refresh = useCallback(async () => {
    if (!authed) return;
    setBusy(true);
    try {
      const [t, s, g] = await Promise.all([
        api.get<TrackableView[]>("/api/trackables"),
        api.get<WorkSession | null>("/api/sessions/open"),
        api.get<unknown[]>("/api/goals"),
      ]);
      setTrackables(t);
      setSession(s);
      /* A session takes the screen whenever one is observed -- whether you just
         started it or it was already running when the app opened. Either way it
         is the thing you are doing, and getting out of it is one tap. Set here
         rather than in an effect on the id: refresh() is the single funnel every
         Start button already goes through. */
      if (s) setExpanded(true);
      setHasGoals(g.length > 0);
      setError(null);

      // A missing plan is normal (nothing committed yet), not an error.
      try {
        const today = localDate();
        const day = await api.get<{ items: PlanItem[] }>(`/api/planning/day/${today}`);
        setPlan(day.items);
        setCapBinding(
          day.items.some((i) => i.score_breakdown.daily_allocation?.capped ?? false),
        );
      } catch {
        setPlan([]);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        clearToken();
        setAuthed(false);
      }
      else setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [authed]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    function openHistory() {
      setShowHistory(true);
    }
    // Listen for the native shell's request to open the session log.
    window.addEventListener("optimus:open-session-log", openHistory as EventListener);
    return () => window.removeEventListener("optimus:open-session-log", openHistory as EventListener);
  }, []);

  /* Tell the native shell what is running, so the menu-bar item and the
     floating pill have a clock to keep. The fact of the session crosses the
     bridge, never a tick: a minimised web view gets throttled, and a timer in
     the menu bar that freezes when you look away is worse than none.

     Keyed on the session id and re-announced when the title arrives, since
     /api/trackables and /api/sessions/open resolve independently. */
  const sessionId = session?.id ?? null;
  const sessionTitle = session
    ? (trackables.find((t) => t.trackable_id === session.trackable_id)?.title ??
       "Session in progress")
    : null;
  useEffect(() => {
    if (session === null) {
      tellDesktop({ type: "session:end" });
      return;
    }
    tellDesktop({
      type: "session:start",
      startedAtMs: new Date(session.started_at).getTime(),
      plannedMinutes: session.planned_minutes,
      title: sessionTitle ?? "Session in progress",
    });
    // Deliberately not keyed on `session`: it changes identity on every
    // refresh, and re-announcing an unchanged session would restart the
    // native clock several times a minute.
  }, [session, sessionId, sessionTitle]);


  /* Hand the session to the floating pill and let the shell minimise the
     window. The app stays expanded underneath, so restoring it puts the
     countdown back exactly where it was. */
  const float = () => {
    if (onDesktop()) tellDesktop({ type: "pill:show" });
  };

  if (!authed) return <AccountGate onSaved={() => setAuthed(true)} />;

  // §2.1: compilation is the expensive part, and making a new user hand-build
  // their graph through forms front-loads exactly the work the system exists to
  // absorb. An empty database opens into the conversation instead.
  if (hasGoals === false) {
    return (
      <>
        {/* No shell: a rail of five tabs and a header would advertise an app
            that does not exist yet. The screen is the conversation and the
            graph coming out of it, and nothing else. */}
        <ErrorBoundary label="The intake view">
          <Intake onApproved={refresh} onAccount={() => setAccountOpen(true)} />
        </ErrorBoundary>
        {accountOpen && <AccountPanel onClose={() => setAccountOpen(false)} onDeleted={leaveAccount} onSignedOut={leaveAccount} />}
      </>
    );
  }

  return (
    <>
      <Shell
        tab={tab}
        setTab={setTab}
        sessionOpen={!!session}
        /* A canvas view gets the whole screen; a column of cards does not.
           The roadmap is a canvas in all three of its modes -- a calendar with
           fewer visible days because a toolbar took the top 56px is a worse
           calendar for no gain. */
        bleed={tab === "tree" || tab === "roadmap" || tab === "dash"}
        onAccount={() => setAccountOpen(true)}
        onOpenSessionLog={() => setShowHistory(true)}
        trackables={trackables}
        onSessionStarted={refresh}
        /* Hidden while a session runs: SessionBar is the timer then, and two
           live timers on one screen is the ambiguity this app avoids. */
        canStartSession={!session && !busy}
      >
        {error && (
          <div className="mb-4">
            <Banner>{error}</Banner>
          </div>
        )}

        <ErrorBoundary key={tab} label={`The ${tab} view`}>
          {tab === "today" && (
            <Today
              items={plan}
              trackables={trackables}
              capBinding={capBinding}
              onChanged={refresh}
              onGenerate={refresh}
              busy={busy}
              sessionOpen={!!session}
            />
          )}
          {tab === "work" && (
            <Trackables trackables={trackables} onStarted={refresh} busy={busy || !!session} />
          )}
          {tab === "tree" && <Tree onStarted={refresh} sessionOpen={!!session} />}
          {tab === "plan" && <Plan trackables={trackables} onChanged={refresh} />}
          {tab === "dash" && <Dashboard onNavigate={setTab} />}
          {tab === "roadmap" && <Roadmap />}
          {tab === "review" && <Review />}
          {tab === "ask" && <Assistant />}
        </ErrorBoundary>
      </Shell>

      {session &&
        (expanded ? (
          <FocusSession
            session={session}
            trackable={trackables.find((t) => t.trackable_id === session.trackable_id)}
            onEnded={refresh}
            onCollapse={() => setExpanded(false)}
            onFloat={float}
          />
        ) : (
          <SessionBar
            session={session}
            trackable={trackables.find((t) => t.trackable_id === session.trackable_id)}
            trackables={trackables}
            onEnded={refresh}
            onChanged={refresh}
            onExpand={() => setExpanded(true)}
            onFloat={float}
          />
        ))}

      {accountOpen && <AccountPanel onClose={() => setAccountOpen(false)} onDeleted={leaveAccount} onSignedOut={leaveAccount} />}
      {showHistory && <SessionHistory onClose={() => setShowHistory(false)} />}
    </>
  );
}

// Tell TypeScript about the custom event dispatched by the native menu.
declare global {
  interface WindowEventMap {
    "optimus:open-session-log": CustomEvent;
  }
}

function AccountGate({ onSaved }: { onSaved: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit() {
    if (!email.trim() || !password || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await api.post<{ token: string }>(
        mode === "login" ? "/api/auth/login" : "/api/auth/register",
        { email, password },
      );
      setToken(result.token);
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setPending(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-sm items-center px-5">
      <Card className="w-full">
        <div className="display text-heading">Optimus</div>
        <p className="mt-2 text-caption leading-relaxed text-muted">
          {mode === "login" ? "Sign in to continue your operating system." : "Create an account to start building your system."}
        </p>
        <Field
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          placeholder="you@example.com"
          className="mt-5"
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          placeholder={mode === "register" ? "At least 8 characters" : "Your password"}
          className="mt-4"
        />
        {error && <div className="mt-4"><Banner>{error}</Banner></div>}
        <Button
          className="mt-4 w-full"
          disabled={!email.trim() || !password}
          pending={pending}
          onClick={submit}
        >
          {mode === "login" ? "Sign In" : "Create Account"}
        </Button>
        <button
          className="mt-4 w-full text-center text-caption text-faint hover:text-ink"
          onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(null); }}
        >
          {mode === "login" ? "New Here? Create an Account" : "Already Have an Account? Sign In"}
        </button>
      </Card>
    </div>
  );
}
