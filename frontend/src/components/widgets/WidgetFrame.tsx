import type { ReactNode } from "react";
import { IconGrip, IconClose } from "../Icons";

/**
 * The chrome around every widget.
 *
 * The drag handle is an explicit grip rather than the whole card, so a widget
 * can contain its own scrollable or clickable content without every
 * interaction turning into a drag. react-grid-layout is told to look for
 * `.widget-grip` via draggableHandle.
 */
export function WidgetFrame({
  title,
  editing,
  onRemove,
  actions,
  children,
}: {
  title: string;
  editing: boolean;
  onRemove?: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-card bg-surface">
      <div className="flex shrink-0 items-center gap-2 px-4 pt-4 pb-2">
        {editing && (
          <span
            className="widget-grip -ml-1 cursor-grab touch-none p-1 text-faint active:cursor-grabbing"
            aria-hidden="true"
          >
            <IconGrip />
          </span>
        )}
        <div className="section-label min-w-0 flex-1 truncate">{title}</div>
        {actions}
        {editing && onRemove && (
          <button
            onClick={onRemove}
            aria-label={`Remove ${title}`}
            className="rounded-control p-1 text-faint transition hover:bg-raised hover:text-ink"
          >
            <IconClose />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">{children}</div>
    </div>
  );
}

/** A widget whose kind this client does not know.
 *
 *  It renders as a placeholder and — crucially — its placement is still saved.
 *  Dropping unknown kinds would mean one stale browser tab silently deleting a
 *  widget the user added from a newer one. */
export function UnknownWidget({ kind }: { kind: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
      <div className="text-body-sm text-muted">This Widget Needs a Newer Version</div>
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-faint">{kind}</div>
    </div>
  );
}
