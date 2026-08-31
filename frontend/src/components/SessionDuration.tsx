/**
 * Choosing how long a session runs (§36.1, reversed).
 *
 * Sessions were fixed at 25 minutes, which kept pace pooling clean at the cost
 * of making the user split an hour of reading into consecutive rows. The length
 * is now theirs to set.
 *
 * §23.1 still governs the interaction: starting from the daily plan is ONE tap.
 * So this renders a prefilled row of presets rather than a required decision --
 * the default is already selected when the control appears, and a user who
 * ignores it entirely gets exactly the behaviour they had before.
 */

import { useEffect, useState } from "react";

import { api } from "../lib/api";
import type { SessionDefaults } from "../lib/types";

/** Cached at module scope: the defaults are constants, and every Start button
    on a screen would otherwise fetch them independently. */
let cached: SessionDefaults | null = null;
let inFlight: Promise<SessionDefaults> | null = null;

const FALLBACK: SessionDefaults = { minutes: 25, presets: [15, 25, 50, 90], min_session_minutes: 5 };

export function useSessionDefaults(): SessionDefaults {
  const [defaults, setDefaults] = useState<SessionDefaults>(cached ?? FALLBACK);

  useEffect(() => {
    if (cached) return;
    let live = true;
    inFlight ??= api.get<SessionDefaults>("/api/sessions/defaults");
    inFlight
      .then((d) => {
        cached = d;
        if (live) setDefaults(d);
      })
      // The control is still usable on the fallback, and a failed lookup of a
      // constant is not worth interrupting the user to report.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  return defaults;
}

export function SessionDuration({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (minutes: number) => void;
  disabled?: boolean;
}) {
  const { presets } = useSessionDefaults();
  const [custom, setCustom] = useState("");
  const isCustom = !presets.includes(value);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {presets.map((m) => (
        <button
          key={m}
          type="button"
          disabled={disabled}
          onClick={() => {
            setCustom("");
            onChange(m);
          }}
          className={`min-h-11 rounded-full px-3 font-mono text-micro font-medium uppercase tracking-label transition-colors disabled:opacity-40 ${
            value === m && !isCustom
              ? "bg-white/12 text-ink"
              : "bg-white/5 text-muted hover:bg-white/10"
          }`}
        >
          {m}m
        </button>
      ))}
      <input
        type="number"
        min={1}
        inputMode="numeric"
        disabled={disabled}
        value={isCustom && custom === "" ? String(value) : custom}
        placeholder="Custom"
        onChange={(e) => {
          setCustom(e.target.value);
          const parsed = Number(e.target.value);
          // Presets are one-tap choices, not a whitelist -- the API takes any
          // positive length. Anything unparseable simply leaves the value alone.
          if (Number.isFinite(parsed) && parsed > 0) onChange(Math.round(parsed));
        }}
        className="no-spin min-h-11 w-20 rounded-full border border-line bg-abyss px-3 text-center font-mono text-micro uppercase tracking-label text-ink outline-none placeholder:text-faint focus:border-muted disabled:opacity-40"
      />
    </div>
  );
}
