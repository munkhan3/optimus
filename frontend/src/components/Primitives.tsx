import type { ReactNode } from "react";

/** A panel. No hard border — separation comes from the surface step. */
export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-2xl bg-surface p-4 sm:p-5 ${className}`}>{children}</div>
  );
}

/** Uppercase, tracked, low contrast — labels a region without competing with it. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="section-label">{children}</div>;
}

/**
 * P7: the filling bar is the motivational engine, not decoration. The existing
 * spreadsheet works because a bar makes a session feel real, and that effect is
 * a feature to preserve.
 */
export function ProgressBar({
  fraction,
  tone = "accent",
}: {
  fraction: number | null;
  tone?: "accent" | "good" | "warn" | "bad";
}) {
  const bar = {
    accent: "bg-accent",
    good: "bg-good",
    warn: "bg-warn",
    bad: "bg-bad",
  }[tone];

  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-raised">
      {fraction !== null && (
        <div
          className={`h-1.5 rounded-full transition-[width] duration-500 ease-out ${bar}`}
          style={{ width: `${Math.min(100, Math.max(0, fraction * 100))}%` }}
        />
      )}
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
    neutral: "bg-raised text-muted",
    good: "bg-good/12 text-good",
    warn: "bg-warn/12 text-warn",
    bad: "bg-bad/12 text-bad",
    accent: "bg-accent/15 text-accent",
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}
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
      <div className="section-label">{label}</div>
      <div className={`mt-1 truncate text-[15px] font-semibold ${color}`}>{value}</div>
      {/* The hint carries provenance ("your estimate — no sessions yet"), so it
          wraps rather than truncating: it is what tells the user how much to
          trust the number above it (P3). */}
      {hint && <div className="mt-0.5 text-[11px] leading-tight text-faint">{hint}</div>}
    </div>
  );
}

/** A hero figure: large, light weight, with its meaning underneath. */
export function BigStat({
  value,
  caption,
  tone,
}: {
  value: ReactNode;
  caption?: ReactNode;
  tone?: "good" | "warn" | "bad";
}) {
  const color =
    tone === "good" ? "text-good" : tone === "warn" ? "text-warn" : tone === "bad" ? "text-bad" : "";
  return (
    <div>
      <div className="text-[32px] font-semibold leading-none tracking-tight sm:text-[38px]">
        {value}
      </div>
      {caption && <div className={`mt-1.5 text-sm ${color || "text-muted"}`}>{caption}</div>}
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
    primary: "bg-accent text-white hover:brightness-110 active:brightness-95",
    ghost: "bg-raised text-ink hover:bg-line active:brightness-95",
    danger: "bg-bad/12 text-bad hover:bg-bad/20",
  } as const;
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      /* min-h-11: a real thumb target. Logging must be nearly free (P5). */
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition disabled:opacity-40 ${styles[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  className = "",
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      {label && <span className="section-label">{label}</span>}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 min-h-11 w-full rounded-xl bg-raised px-3 text-sm text-ink outline-none placeholder:text-faint focus:ring-1 focus:ring-accent"
      />
    </label>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-line px-4 py-12 text-center">
      <div className="text-sm font-medium text-ink">{title}</div>
      {hint && <div className="mx-auto mt-1.5 max-w-sm text-xs text-faint">{hint}</div>}
    </div>
  );
}
