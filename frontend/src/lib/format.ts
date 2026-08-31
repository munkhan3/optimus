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
      return `Measured Over ${n} Sessions`;
    case "shrunk":
      return `${n} Session${n === 1 ? "" : "s"}, Blended With Your Estimate`;
    case "prior_only":
      return "Your Estimate — No Sessions Yet";
    case "pooled_prior":
      return "Borrowed From Similar Work";
    case "unavailable":
      return "Not Enough Data";
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
  if (!projection.earliest || !projection.latest) return "Not Enough Data";
  if (projection.earliest === projection.latest) return dateShort(projection.earliest);
  return `${dateShort(projection.earliest)} – ${dateShort(projection.latest)}`;
}

export function elapsed(fromIso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(fromIso).getTime()) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Time left in a session, and then time spent past it.
 *
 * Derived from started_at on every call rather than decremented, for the same
 * reason `elapsed` is: a counter that ticks drifts, and this one has to agree
 * with a server that computes the duration from two timestamps.
 *
 * Past zero it keeps going and says so. The session did not fail to end -- the
 * user chose not to stop, and that choice is the measurement.
 */
export function countdown(
  fromIso: string,
  plannedMinutes: number,
): { text: string; seconds: number; overtime: boolean } {
  const gone = Math.floor((Date.now() - new Date(fromIso).getTime()) / 1000);
  const left = plannedMinutes * 60 - gone;
  const overtime = left < 0;
  const magnitude = Math.abs(left);
  const m = Math.floor(magnitude / 60);
  const s = magnitude % 60;
  return {
    text: `${overtime ? "+" : ""}${m}:${String(s).padStart(2, "0")}`,
    // Negative once past the boundary, so callers can compare rather than
    // re-deriving which side of it they are on.
    seconds: left,
    overtime,
  };
}

export function relativeDays(days: number | null): string {
  if (days === null) return "Never";
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
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
      ? "Every Week"
      : `Every ${g.reset_period_days} Days`;
  }
  if (g.deadline) return `By ${g.deadline}`;
  return g.activation === "active" ? "No Deadline" : "Parked — No Deadline";
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

/**
 * Title Case for labels, captions and data readouts.
 *
 * Used for values that arrive lowercase from the API -- task types, health
 * component names, baseline resolutions -- so a label reads "Reading" and
 * "Move Deadline" rather than shouting the database's spelling at the user.
 *
 * Full sentences are never passed through this. A sentence in Title Case reads
 * as a headline, and most of the prose in this app is deliberately a sentence:
 * an explanation of why a number is missing, or what a warning means.
 */
const MINOR = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "in", "nor",
  "of", "on", "or", "per", "the", "to", "vs", "with",
]);

export function titleCase(text: string): string {
  const words = text.replace(/[_-]/g, " ").trim().split(/\s+/);
  return words
    .map((word, i) => {
      const lower = word.toLowerCase();
      // Small words stay small unless they open or close the phrase.
      if (i > 0 && i < words.length - 1 && MINOR.has(lower)) return lower;
      // Leave anything already carrying interior capitals alone -- it is a
      // proper noun or an acronym the user typed, not ours to restyle.
      if (/[A-Z]/.test(word.slice(1))) return word;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}
