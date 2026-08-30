import { WIDGETS } from "./registry";
import { Button } from "../Primitives";
import { IconClose } from "../Icons";

/** The picker. Lists what each widget answers, not just what it is called. */
export function AddWidget({
  present,
  onAdd,
  onClose,
}: {
  present: Set<string>;
  onAdd: (kind: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-void/60 p-0 backdrop-blur-sm sm:items-center sm:p-6">
      <div
        role="dialog"
        aria-label="Add a widget"
        className="max-h-[80dvh] w-full max-w-[560px] overflow-auto rounded-t-card bg-surface p-5 sm:rounded-card sm:p-6"
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="display text-subheading">Add a Widget</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-control p-2 text-faint transition hover:bg-raised hover:text-ink"
          >
            <IconClose />
          </button>
        </div>

        <div className="space-y-2">
          {WIDGETS.map((spec) => {
            const added = present.has(spec.kind);
            return (
              <div
                key={spec.kind}
                className="flex items-center justify-between gap-4 rounded-control bg-abyss p-3"
              >
                <div className="min-w-0">
                  <div className="text-body-sm text-ink">{spec.title}</div>
                  <div className="text-[11px] text-faint">{spec.blurb}</div>
                </div>
                <div className="shrink-0">
                  <Button variant="ghost" onClick={() => onAdd(spec.kind)}>
                    {/* Duplicates are allowed: two commitment grids scoped to
                        different goals is a reasonable board. The label just
                        says what is already there. */}
                    {added ? "Add Another" : "Add"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
