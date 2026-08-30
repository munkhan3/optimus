/**
 * The one place a chart is allowed to know a colour.
 *
 * visx renders plain SVG and ships no styling, which is exactly why it was
 * chosen: every stroke and fill here comes from the tokens in index.css, so a
 * chart cannot drift away from the rest of the product the way a library's
 * defaults would.
 *
 * design.md's rules that bite hardest in a chart:
 *   - No chromatic colour below 18px. Axis ticks and small labels are --muted,
 *     never a series colour, because at 10px on near-black they vibrate.
 *   - Chromatic colour means a data signal. Emphasis is white.
 *   - Separation is a colour step, not a border. Grid lines are barely there.
 */

/** Read a CSS custom property. SVG attributes cannot take var() everywhere. */
function token(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export const chart = {
  ink: () => token("--color-ink", "#f5f5f7"),
  muted: () => token("--color-muted", "#9f9fa0"),
  faint: () => token("--color-faint", "#6a6b6b"),
  line: () => token("--color-line", "#3f4041"),
  surface: () => token("--color-surface", "#1a1b1c"),
  raised: () => token("--color-raised", "#2e2e2e"),
  abyss: () => token("--color-abyss", "#090a0b"),
  iris: () => token("--color-iris", "#847dff"),
  cyan: () => token("--color-cyan", "#00b3dd"),
  good: () => token("--color-good", "oklch(0.78 0.155 155)"),
  warn: () => token("--color-warn", "oklch(0.80 0.140 75)"),
  bad: () => token("--color-bad", "oklch(0.68 0.170 20)"),
};

/** The six-step categorical ramp, shared with the goal graph's areas. */
export const SERIES = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-6)",
];

export const seriesColor = (i: number) => SERIES[i % SERIES.length];

/** Axis props shared by every chart, so tick treatment cannot diverge. */
export const axisProps = {
  stroke: "var(--color-line)",
  tickStroke: "var(--color-line)",
  tickLabelProps: () =>
    ({
      fill: "var(--color-faint)",
      fontSize: 10,
      fontFamily: "var(--font-mono)",
      letterSpacing: "0.08em",
      textAnchor: "middle" as const,
      dy: "0.33em",
    }) as const,
};

export const axisLeftProps = {
  ...axisProps,
  tickLabelProps: () =>
    ({
      fill: "var(--color-faint)",
      fontSize: 10,
      fontFamily: "var(--font-mono)",
      letterSpacing: "0.08em",
      textAnchor: "end" as const,
      dx: "-0.25em",
      dy: "0.33em",
    }) as const,
};

/**
 * Tone for a feasibility margin, in the vocabulary the rest of the app uses.
 *
 * `null` is undeterminable, which §24.6 insists is not the same as feasible --
 * so it gets the neutral treatment, never the good one.
 */
export type Tone = "good" | "warn" | "bad" | "neutral";

export function feasibilityTone(margin: number | null | undefined, feasible?: boolean | null): Tone {
  if (feasible === false) return "bad";
  if (margin === null || margin === undefined || feasible === null) return "neutral";
  if (margin < 0) return "bad";
  if (margin < 2) return "warn";
  return "good";
}

export const toneColor: Record<Tone, string> = {
  good: "var(--color-good)",
  warn: "var(--color-warn)",
  bad: "var(--color-bad)",
  neutral: "var(--color-line)",
};

/**
 * The intensity ramp for the commitment grid.
 *
 * Zero is the empty surface, not the faintest ink: an unworked day and a barely
 * worked day must not look alike, or the grid stops being evidence. Above zero
 * it steps rather than fades continuously, because four legible levels read
 * better at 11px than a smooth gradient nobody can distinguish.
 */
export function intensity(value: number, peak: number): { fill: string; level: number } {
  if (value <= 0 || peak <= 0) return { fill: "var(--color-abyss)", level: 0 };
  const ratio = Math.min(value / peak, 1);
  const level = ratio > 0.75 ? 4 : ratio > 0.5 ? 3 : ratio > 0.25 ? 2 : 1;
  const opacity = [0, 0.28, 0.48, 0.72, 1][level];
  return { fill: `color-mix(in oklab, var(--color-iris) ${opacity * 100}%, var(--color-abyss))`, level };
}
