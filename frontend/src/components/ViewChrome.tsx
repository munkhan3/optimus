import type { ReactNode } from "react";

/**
 * The floating controls that sit over a full-bleed view.
 *
 * Extracted from the goal graph, which established the arrangement: the thing
 * that changes WHAT you are looking at goes bottom-left, the things that change
 * WHERE you are looking go bottom-right, and a hint sits centred between them.
 * Keeping them in one file is what stops the roadmap from drifting into a
 * slightly different bar with slightly different padding.
 *
 * They float rather than occupying a header row because a view should get the
 * whole canvas. A toolbar that takes 56px off the top of a calendar costs a
 * row of days for the whole life of the app.
 */

/**
 * Bottom offset for the floating controls.
 *
 * A bleed view fills the screen, which on a phone means it runs underneath the
 * fixed tab bar (Shell's MOBILE_NAV_H, 60px). Anchoring to bottom-4 there puts
 * the controls behind the nav where they cannot be reached at all, so on small
 * screens they sit above it and only drop to the corner once the nav is gone.
 */
const BOTTOM = "bottom-[calc(76px+env(safe-area-inset-bottom))] lg:bottom-4";

const CHIP =
  "px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] transition duration-200";

/** Bottom-left. A segmented control over the view's modes. */
export function ViewSwitch<T extends string>({
  value,
  options,
  onChange,
  label = "View",
}: {
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (next: T) => void;
  label?: string;
}) {
  return (
    <div
      className="flex overflow-hidden rounded-control border border-line bg-surface"
      role="group"
      aria-label={label}
    >
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          title={o.hint}
          className={`${CHIP} ${
            value === o.value ? "bg-line/60 text-ink" : "text-muted hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A single floating action, matching the switch's weight. */
export function ViewButton({
  onClick,
  children,
  title,
  disabled,
}: {
  onClick: () => void;
  children: ReactNode;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`${CHIP} rounded-control border border-line bg-surface text-muted hover:text-ink disabled:opacity-40 disabled:hover:text-muted`}
    >
      {children}
    </button>
  );
}

/** A read-only floating label — a month name, a week range. */
export function ViewLabel({ children }: { children: ReactNode }) {
  return (
    <span
      className={`${CHIP} rounded-control border border-line bg-surface text-ink`}
    >
      {children}
    </span>
  );
}

/** Bottom-left slot. */
export function ViewBarLeft({ children }: { children: ReactNode }) {
  return <div className={`absolute ${BOTTOM} left-4 z-20 flex gap-2`}>{children}</div>;
}

/** Bottom-right slot. */
export function ViewBarRight({ children }: { children: ReactNode }) {
  return <div className={`absolute ${BOTTOM} right-4 z-20 flex gap-2`}>{children}</div>;
}

/**
 * Centred hint. Never interactive, so it cannot swallow a drag aimed at the
 * canvas underneath it.
 */
export function ViewHint({ children }: { children: ReactNode }) {
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 ${BOTTOM} z-10 hidden px-4 text-center text-[12px] text-faint sm:block`}
    >
      {children}
    </div>
  );
}

/**
 * Top-right slot, for a legend.
 *
 * Legends belong here rather than under the content: anchored to the bottom
 * they move every time the list they describe grows a row, so the key you were
 * reading is somewhere else the next time you look for it.
 */
export function ViewLegend({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute right-4 top-4 z-20 flex flex-wrap justify-end gap-x-4 gap-y-1 rounded-control border border-line bg-surface/90 px-3 py-2 font-mono text-[9px] uppercase tracking-[0.08em] text-faint backdrop-blur">
      {children}
    </div>
  );
}
