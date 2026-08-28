import { useCallback, useEffect, useState } from "react";
import { api, ApiError, getToken, setToken } from "./lib/api";
import type { PlanItem, TrackableView, WorkSession } from "./lib/types";
import { SessionBar } from "./components/SessionBar";
import { Button, Card, Field } from "./components/Primitives";
import { Shell, type Tab } from "./components/Shell";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Trackables } from "./views/Trackables";
import { Today } from "./views/Today";
import { Plan } from "./views/Plan";
import { Review } from "./views/Review";
import { Tree } from "./views/Tree";
import { Assistant } from "./views/Assistant";
import { Intake } from "./views/Intake";

export default function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));
  const [tab, setTab] = useState<Tab>("today");
  // null = not yet known. Distinguishing that from "empty" keeps the
  // intake screen from flashing before the first response lands.
  const [hasGoals, setHasGoals] = useState<boolean | null>(null);
  const [trackables, setTrackables] = useState<TrackableView[]>([]);
  const [session, setSession] = useState<WorkSession | null>(null);
  const [plan, setPlan] = useState<PlanItem[]>([]);
  const [capBinding, setCapBinding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        const today = new Date().toISOString().slice(0, 10);
        const day = await api.get<{ items: PlanItem[] }>(`/api/planning/day/${today}`);
        setPlan(day.items);
        setCapBinding(
          day.items.some((i) => i.score_breakdown.daily_allocation?.capped ?? false),
        );
      } catch {
        setPlan([]);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuthed(false);
      else setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [authed]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!authed) return <TokenGate onSaved={() => setAuthed(true)} />;

  // §2.1: compilation is the expensive part, and making a new user hand-build
  // their graph through forms front-loads exactly the work the system exists to
  // absorb. An empty database opens into the conversation instead.
  if (hasGoals === false) {
    return (
      <Shell tab="intake" setTab={setTab}>
        <ErrorBoundary label="The intake view">
          <Intake onApproved={refresh} />
        </ErrorBoundary>
      </Shell>
    );
  }

  return (
    <>
      <Shell tab={tab} setTab={setTab}>
        {error && (
          <div className="mb-4 rounded-xl bg-bad/10 px-4 py-3 text-xs text-bad">{error}</div>
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
            />
          )}
          {tab === "work" && (
            <Trackables trackables={trackables} onStarted={refresh} busy={busy || !!session} />
          )}
          {tab === "tree" && <Tree />}
          {tab === "plan" && <Plan trackables={trackables} onChanged={refresh} />}
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
    </>
  );
}

/** §19: one token, pasted once. There is no login because there is one user. */
function TokenGate({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="mx-auto flex min-h-dvh max-w-sm items-center px-5">
      <Card className="w-full">
        <div className="text-lg font-semibold tracking-tight">Optimus</div>
        <p className="mt-1.5 text-xs leading-relaxed text-muted">
          Paste your access token. Single user, so this is the only credential — it is stored on
          this device.
        </p>
        <Field
          label="Token"
          type="password"
          value={value}
          onChange={setValue}
          placeholder="••••••••"
          className="mt-4"
        />
        <Button
          className="mt-4 w-full"
          disabled={!value.trim()}
          onClick={() => {
            setToken(value);
            onSaved();
          }}
        >
          Continue
        </Button>
      </Card>
    </div>
  );
}
