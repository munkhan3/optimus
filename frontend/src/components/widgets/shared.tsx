import type { ReactNode } from "react";
import { Empty, Skeleton } from "../Primitives";

/**
 * Loading, failed, and empty are three different states and must look like it.
 *
 * A metrics dashboard that renders "0" while it is still fetching teaches the
 * user that its numbers are guesses. `undefined` is a skeleton, `null` is a
 * message, and genuinely-no-data is an Empty that says so.
 */
export function Gate<T>({
  value,
  empty,
  emptyHint,
  children,
}: {
  value: T | null | undefined;
  empty?: string;
  emptyHint?: string;
  children: (value: T) => ReactNode;
}) {
  if (value === undefined) return <Skeleton className="h-[100px]" />;
  if (value === null) {
    return <div className="text-body-sm text-muted">Could not load this widget.</div>;
  }
  if (Array.isArray(value) && value.length === 0) {
    return <Empty title={empty ?? "Nothing Here Yet"} hint={emptyHint} />;
  }
  return <>{children(value)}</>;
}

/** A labelled horizontal bar. Used wherever a widget ranks things. */
export function BarRow({
  label,
  hint,
  fraction,
  color,
  value,
}: {
  label: string;
  hint?: ReactNode;
  fraction: number | null;
  color: string;
  value: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-body-sm text-ink">{label}</span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted">{value}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-abyss">
        {fraction !== null && (
          <div
            className="h-full rounded-full transition-[width] duration-200 ease-out"
            style={{ width: `${Math.max(0, Math.min(fraction, 1)) * 100}%`, background: color }}
          />
        )}
      </div>
      {hint && <div className="text-[11px] text-faint">{hint}</div>}
    </div>
  );
}

/** A scrollable stack of rows, so a widget never grows past its grid cell. */
export function Rows({ children }: { children: ReactNode }) {
  return <div className="space-y-3">{children}</div>;
}
