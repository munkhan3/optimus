import type { ReactNode } from "react";

/** A panel. No hard border, no shadow — separation comes from the surface step
    (design.md: differentiate by colour step, the system is intentionally flat). */
export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-card bg-surface p-5 sm:p-6 ${className}`}>{children}</div>
  );
}

/**
 * The Silver inverted card — the one light object in a dark room.
 *
 * design.md caps this at one or two per screen, and that scarcity is the point:
 * it is not a style, it is a way of saying "this one". Today spends it on rank
 * #01, which is the item the screen is already telling you to start.
 */
export function InvertedCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`inverted rounded-inverted bg-silver p-5 text-void sm:p-6 ${className}`}>
      {children}
    </div>
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
    accent: "bg-iris",
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
    neutral: "bg-white/10 text-muted",
    good: "bg-good/12 text-good",
    warn: "bg-warn/12 text-warn",
    bad: "bg-bad/12 text-bad",
    accent: "bg-white/12 text-ink",
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.12em] ${tones[tone]}`}
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
      <div className={`mt-1.5 truncate text-body-sm font-medium ${color}`}>{value}</div>
      {/* The hint carries provenance ("your estimate — no sessions yet"), so it
          wraps rather than truncating: it is what tells the user how much to
          trust the number above it (P3). */}
      {hint && <div className="mt-1 text-[11px] leading-tight text-faint">{hint}</div>}
    </div>
  );
}

/**
 * A hero figure in the display voice at weight 300.
 *
 * design.md calls this authority through restraint: at 38px the convention is
 * 600–700, and whispering instead is the whole move. The figure is the serif;
 * mono stays where design.md puts it, on the uppercase label beneath.
 */
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
      <div className="display text-heading sm:text-display">{value}</div>
      {caption && <div className={`mt-2 text-body-sm ${color || "text-muted"}`}>{caption}</div>}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  pending,
  arrow = variant === "primary",
  className = "",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
  /** In-flight. Blocks the click as well as showing it: without this every async
      button in the app stays live while its request runs, and a double tap on
      Commit fires two commits. */
  pending?: boolean;
  arrow?: boolean;
  className?: string;
  type?: "button" | "submit";
}) {
  /* design.md: white fill, black text, the highest-contrast pair in the system
     and the only primary action. Ghost is a hairline outline, not a filled
     surface, so exactly one thing on a screen ever reads as the action. */
  const styles = {
    primary: "bg-pure text-void hover:bg-ink active:brightness-90",
    ghost: "border border-line bg-transparent text-ink hover:bg-raised",
    danger: "border border-bad/40 bg-transparent text-bad hover:bg-bad/12",
  } as const;
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      /* min-h-11: a real thumb target. Logging must be nearly free (P5). */
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-control px-4 text-body-sm font-medium transition duration-200 ease-out disabled:opacity-40 ${styles[variant]} ${className}`}
    >
      {pending ? <Spinner /> : null}
      {children}
      {arrow && !pending && <span aria-hidden="true">→</span>}
    </button>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
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
        className="mt-1.5 min-h-11 w-full rounded-control border border-line bg-abyss px-3 text-body-sm text-ink outline-none placeholder:text-faint focus:border-muted"
      />
    </label>
  );
}

/**
 * One treatment for anything that went wrong or needs attention.
 *
 * There were five of these inline before, at four different paddings and three
 * different alpha values, which meant an error looked slightly different
 * depending on which screen produced it.
 */
export function Banner({
  tone = "bad",
  title,
  children,
}: {
  tone?: "bad" | "warn";
  title?: ReactNode;
  children?: ReactNode;
}) {
  const tones = {
    bad: "bg-bad/8 text-bad",
    warn: "bg-warn/8 text-warn",
  } as const;
  return (
    <div className={`rounded-card px-4 py-3 ${tones[tone]}`} role="alert">
      {title && <div className="text-body-sm font-medium">{title}</div>}
      {children && (
        <div className={`text-[13px] leading-relaxed text-muted ${title ? "mt-1.5" : ""}`}>
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Loading is not emptiness.
 *
 * Both loading states in the app used to render the dashed Empty box, which is
 * the visual language for "there is nothing here" — the opposite of what is
 * true while a request is in flight.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`rounded-card bg-surface ${className}`}
      style={{
        background:
          "linear-gradient(90deg, var(--color-surface) 25%, var(--color-raised) 37%, var(--color-surface) 63%)",
        backgroundSize: "200% 100%",
        animation: "shimmer 1.6s ease-in-out infinite",
      }}
    />
  );
}

/** A stack of card-shaped skeletons, for a list that has not arrived yet. */
export function SkeletonList({ rows = 3, height = "h-24" }: { rows?: number; height?: string }) {
  return (
    <div className="space-y-3" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={height} />
      ))}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-card border border-dashed border-line px-4 py-12 text-center">
      <div className="text-body-sm font-medium text-ink">{title}</div>
      {hint && <div className="mx-auto mt-2 max-w-sm text-[13px] leading-relaxed text-faint">{hint}</div>}
    </div>
  );
}
