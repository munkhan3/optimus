import type { ReactNode } from "react";

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-line bg-raised p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)] ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * P7: the filling bar is the motivational engine, not decoration. The existing
 * spreadsheet works because a bar makes a session feel real, and that effect is
 * a feature to preserve.
 */
export function ProgressBar({ fraction }: { fraction: number | null }) {
  if (fraction === null) {
    return (
      <div className="h-2 w-full rounded-full bg-line">
        <div className="h-2 w-0 rounded-full" />
      </div>
    );
  }
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-line">
      <div
        className="h-2 rounded-full bg-accent transition-[width] duration-500 ease-out"
        style={{ width: `${Math.min(100, Math.max(0, fraction * 100))}%` }}
      />
    </div>
  );
}

/**
 * D3: model-estimated and provisional values are flagged wherever they appear,
 * so the user always knows which numbers the system actually stands behind.
 */
export function Tag({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad" | "accent";
}) {
  const tones = {
    neutral: "bg-line/60 text-muted",
    good: "bg-good/12 text-good",
    warn: "bg-warn/15 text-warn",
    bad: "bg-bad/12 text-bad",
    accent: "bg-accent/12 text-accent",
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "good" | "warn" | "bad";
}) {
  const color =
    tone === "good" ? "text-good" : tone === "warn" ? "text-warn" : tone === "bad" ? "text-bad" : "";
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`truncate text-sm font-semibold ${color}`}>{value}</div>
      {/* The hint carries provenance ("your estimate -- no sessions yet"), so it
          wraps rather than truncating: it is what tells the user how much to
          trust the number above it (P3). */}
      {hint && <div className="text-[11px] leading-tight text-muted">{hint}</div>}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  className = "",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit";
}) {
  const styles = {
    primary: "bg-accent text-white active:bg-accent/85 disabled:bg-muted/40",
    ghost: "border border-line bg-raised text-ink active:bg-line/40",
    danger: "border border-bad/30 bg-raised text-bad active:bg-bad/10",
  } as const;
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      /* min-h-11: a real thumb target. Logging must be nearly free (P5). */
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition disabled:opacity-50 ${styles[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-line px-4 py-10 text-center">
      <div className="text-sm font-medium text-ink">{title}</div>
      {hint && <div className="mx-auto mt-1 max-w-xs text-xs text-muted">{hint}</div>}
    </div>
  );
}
