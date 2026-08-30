import { useCallback, useEffect, useState } from "react";
import { api, ApiError, clearToken, getToken, setToken } from "./lib/api";
import type { PlanItem, TrackableView, WorkSession } from "./lib/types";
import { localDate } from "./lib/format";
import { SessionBar } from "./components/SessionBar";
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

      {session && (
        <SessionBar
          session={session}
          trackable={trackables.find((t) => t.trackable_id === session.trackable_id)}
          onEnded={refresh}
        />
      )}
      {accountOpen && <AccountPanel onClose={() => setAccountOpen(false)} onDeleted={leaveAccount} onSignedOut={leaveAccount} />}
    </>
  );
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
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
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
          className="mt-4 w-full text-center text-[12px] text-faint hover:text-ink"
          onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(null); }}
        >
          {mode === "login" ? "New Here? Create an Account" : "Already Have an Account? Sign In"}
        </button>
      </Card>
    </div>
  );
}
