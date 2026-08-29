/**
 * Display helpers.
 *
 * P2 shows up here more than anywhere: the UI must never render a fabricated
 * number. Where the engine returns null, these return an em-dash and the
 * caller says why -- an absent value and a zero look nothing alike.
 */

import type { Basis, PaceEstimate, Projection } from "./types";

export const DASH = "—";

export function num(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return DASH;
  return value.toFixed(digits);
}

export function pct(fraction: number | null): string {
  if (fraction === null) return DASH;
  return `${Math.round(fraction * 100)}%`;
}

/** How much weight the user should put on a pace number. */
export function basisLabel(basis: Basis, n: number): string {
  switch (basis) {
    case "observed":
      return `measured over ${n} sessions`;
    case "shrunk":
      return `${n} session${n === 1 ? "" : "s"}, blended with your estimate`;
    case "prior_only":
      return "your estimate — no sessions yet";
    case "pooled_prior":
      return "borrowed from similar work";
    case "unavailable":
      return "not enough data";
  }
}

export function paceText(pace: PaceEstimate, unit: string): string {
  if (pace.point === null) return `${DASH} ${unit}/session`;
  return `${num(pace.point)} ${unit}/session`;
}

export function intervalText(pace: PaceEstimate, unit: string): string | null {
  if (!pace.interval || pace.point === null) return null;
  const { low, high } = pace.interval;
  if (high - low < 1e-9) return null;
  return `${num(low)}–${num(high)} ${unit}`;
}

export function dateShort(iso: string | null): string {
  if (!iso) return DASH;
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** §24.7: always a range, never a single date. */
export function projectionText(projection: Projection): string {
  if (!projection.earliest || !projection.latest) return "not enough data";
  if (projection.earliest === projection.latest) return dateShort(projection.earliest);
  return `${dateShort(projection.earliest)} – ${dateShort(projection.latest)}`;
}

export function elapsed(fromIso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(fromIso).getTime()) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function relativeDays(days: number | null): string {
  if (days === null) return "never";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

/**
 * What a goal's timing line should say.
 *
 * §12 draws a distinction the naive "deadline ?: no deadline" collapses: a
 * recurring commitment has no single date but a deadline every period, and is
 * emphatically not an intention. Calling it "no deadline -- parked" tells the
 * user the opposite of the truth about work they are actively committed to.
 */
export function goalTiming(g: {
  deadline: string | null;
  activation: string;
  pace_mode?: string;
  reset_period_days?: number | null;
}): string {
  if (g.pace_mode === "reset_period" && g.reset_period_days) {
    return g.reset_period_days === 7
      ? "every week"
      : `every ${g.reset_period_days} days`;
  }
  if (g.deadline) return `by ${g.deadline}`;
  return g.activation === "active" ? "no deadline" : "parked — no deadline";
}

/**
 * Today's calendar date, in the user's timezone.
 *
 * `new Date().toISOString().slice(0, 10)` is the obvious spelling and it is
 * wrong: it converts to UTC first, so anywhere west of Greenwich the date rolls
 * over early in the evening. The server keys plans and capacity weeks on its own
 * local date, so the two disagree for hours every day -- the client asks for
 * tomorrow's plan and gets a 404, and a declared capacity week lands on the
 * wrong Monday and cannot be committed against.
 */
export function localDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The Monday of the week containing `d`, as a local calendar date. */
export function mondayOf(d: Date = new Date()): string {
  const copy = new Date(d);
  copy.setDate(copy.getDate() - ((copy.getDay() + 6) % 7));
  return localDate(copy);
}
