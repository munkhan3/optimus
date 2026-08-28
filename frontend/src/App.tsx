import { useCallback, useEffect, useState } from "react";
import { api, ApiError, getToken, setToken } from "./lib/api";
import type { PlanItem, TrackableView, WorkSession } from "./lib/types";
import { SessionBar } from "./components/SessionBar";
import { Button, Card } from "./components/Primitives";
import { Trackables } from "./views/Trackables";
import { Today } from "./views/Today";
import { Assistant } from "./views/Assistant";
import { Plan } from "./views/Plan";
import { Review } from "./views/Review";

type Tab = "today" | "work" | "plan" | "review" | "ask";

const TABS: { id: Tab; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "work", label: "Work" },
  { id: "plan", label: "Plan" },
  { id: "review", label: "Week" },
  { id: "ask", label: "Ask" },
];

export default function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));
  const [tab, setTab] = useState<Tab>("today");
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
      const [t, s] = await Promise.all([
        api.get<TrackableView[]>("/api/trackables"),
        api.get<WorkSession | null>("/api/sessions/open"),
      ]);
      setTrackables(t);
      setSession(s);
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

  return (
    <div className="min-h-dvh">
      <header className="safe-top sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-3">
          <div>
            <div className="text-sm font-bold tracking-tight">Goal OS</div>
            <div className="text-[11px] text-muted">
              {new Date().toLocaleDateString(undefined, {
                weekday: "long",
                month: "short",
                day: "numeric",
              })}
            </div>
          </div>
          <nav className="flex rounded-xl border border-line bg-raised p-0.5">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`min-h-9 rounded-lg px-2.5 text-xs font-semibold transition ${
                  tab === t.id ? "bg-accent text-white" : "text-muted"
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className={`mx-auto max-w-2xl px-4 py-4 ${session ? "pb-40" : "pb-16"}`}>
        {error && (
          <div className="mb-3 rounded-xl bg-bad/8 px-3 py-2 text-xs text-bad">{error}</div>
        )}

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
        {tab === "plan" && <Plan trackables={trackables} onChanged={refresh} />}
        {tab === "review" && <Review />}
        {tab === "ask" && <Assistant />}
      </main>

      {session && (
        <SessionBar
          session={session}
          trackable={trackables.find((t) => t.trackable_id === session.trackable_id)}
          onEnded={refresh}
        />
      )}
    </div>
  );
}

/** §19: one token, pasted once. There is no login because there is one user. */
function TokenGate({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="mx-auto flex min-h-dvh max-w-sm items-center px-4">
      <Card className="w-full">
        <div className="text-base font-bold">Goal OS</div>
        <p className="mt-1 text-xs text-muted">
          Paste your access token. Single user, so this is the only credential — it is stored on
          this device.
        </p>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="token"
          className="mt-3 min-h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm outline-none focus:border-accent"
        />
        <Button
          className="mt-3 w-full"
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
