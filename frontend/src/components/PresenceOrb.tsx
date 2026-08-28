/**
 * The thing on screen that shows the system is present.
 *
 * `level` is 0–1. Today it is synthesized from whether the model is thinking;
 * when voice lands it becomes AnalyserNode RMS from the microphone and this
 * component does not change. That is the whole point of taking a number rather
 * than a boolean.
 */
export type OrbState = "idle" | "listening" | "thinking" | "speaking";

const TONE: Record<OrbState, string> = {
  idle: "var(--color-line)",
  listening: "var(--color-good)",
  thinking: "var(--color-accent)",
  speaking: "var(--color-accent)",
};

export function PresenceOrb({
  state = "idle",
  level = 0,
  size = 76,
}: {
  state?: OrbState;
  level?: number;
  size?: number;
}) {
  const tone = TONE[state];
  const clamped = Math.min(1, Math.max(0, level));
  const active = state !== "idle";

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      {/* Outer halo: reacts to level, so a louder voice or harder thinking
          visibly pushes it outward. */}
      <div
        className="absolute inset-0 rounded-full transition-transform duration-150 ease-out"
        style={{
          background: tone,
          opacity: active ? 0.14 : 0.08,
          transform: `scale(${0.72 + clamped * 0.28})`,
        }}
      />
      <div
        className="absolute rounded-full transition-transform duration-200 ease-out"
        style={{
          inset: size * 0.16,
          background: tone,
          opacity: active ? 0.3 : 0.16,
          transform: `scale(${0.86 + clamped * 0.14})`,
        }}
      />
      <div
        className="absolute rounded-full"
        style={{
          inset: size * 0.32,
          background: tone,
          opacity: active ? 0.95 : 0.4,
          animation: active ? "orbPulse 1.9s ease-in-out infinite" : undefined,
        }}
      />
    </div>
  );
}
