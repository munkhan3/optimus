import type { ReactNode } from "react";
import { IconAsk, IconPlan, IconToday, IconWeek, IconWork } from "./Icons";

export type Tab = "today" | "work" | "plan" | "review" | "ask";

/** Grouped the way Origin groups: what you do daily, then what you set up. */
const GROUPS: { label: string; items: { id: Tab; label: string; Icon: typeof IconToday }[] }[] = [
  {
    label: "Track",
    items: [
      { id: "today", label: "Today", Icon: IconToday },
      { id: "work", label: "Work", Icon: IconWork },
      { id: "review", label: "Week", Icon: IconWeek },
    ],
  },
  {
    label: "Plan",
    items: [{ id: "plan", label: "Goals & capacity", Icon: IconPlan }],
  },
];

const ALL_TABS = GROUPS.flatMap((g) => g.items);

/**
 * Two navigations, one source of truth.
 *
 * Desktop gets Origin's fixed left rail. Mobile gets a bottom bar, because the
 * app has to stay usable on a phone -- logging is only nearly free (P5) if it
 * does not require being at a laptop, and a 260px rail would eat a phone
 * screen. Same tabs, same state, different chrome.
 */
export function Shell({
  tab,
  setTab,
  children,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  children: ReactNode;
}) {
  const active = ALL_TABS.find((t) => t.id === tab);

  return (
    <div className="min-h-dvh lg:flex">
      {/* ---------------------------------------------------- desktop rail */}
      <aside className="fixed inset-y-0 left-0 hidden w-[248px] flex-col border-r border-line bg-bg px-3 py-5 lg:flex">
        <div className="flex items-center gap-2.5 px-3 pb-6">
          <Mark />
          <span className="text-[17px] font-semibold tracking-tight">Optimus</span>
        </div>

        <nav className="flex-1 space-y-6">
          {GROUPS.map((group) => (
            <div key={group.label}>
              <div className="section-label px-3 pb-2">{group.label}</div>
              <div className="space-y-0.5">
                {group.items.map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    onClick={() => setTab(id)}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition ${
                      tab === id
                        ? "bg-raised font-medium text-ink"
                        : "text-muted hover:bg-surface hover:text-ink"
                    }`}
                  >
                    <Icon />
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* Origin pins its assistant to the bottom of the rail, out of the way
            until wanted. Same here -- it is read-only, so it is never the
            primary action. */}
        <button
          onClick={() => setTab("ask")}
          className={`flex items-center gap-2.5 rounded-xl px-3 py-3 text-sm transition ${
            tab === "ask" ? "bg-raised text-ink" : "bg-surface text-muted hover:text-ink"
          }`}
        >
          <IconAsk className="size-4 shrink-0 text-accent" />
          Ask anything
        </button>
      </aside>

      {/* --------------------------------------------------------- content */}
      <div className="flex min-w-0 flex-1 flex-col lg:ml-[248px]">
        <header className="safe-top sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur">
          <div className="flex items-center justify-between px-4 py-3.5 sm:px-6 lg:px-10">
            <div className="flex items-center gap-2.5">
              <span className="lg:hidden">
                <Mark />
              </span>
              <div>
                <h1 className="text-[15px] font-semibold tracking-tight lg:text-lg">
                  {tab === "ask" ? "Ask" : (active?.label ?? "Optimus")}
                </h1>
                <div className="text-[11px] text-faint">
                  {new Date().toLocaleDateString(undefined, {
                    weekday: "long",
                    month: "short",
                    day: "numeric",
                  })}
                </div>
              </div>
            </div>
          </div>
        </header>

        <main className="w-full max-w-[1100px] flex-1 px-4 py-5 pb-28 sm:px-6 lg:px-10 lg:pb-10">
          {children}
        </main>
      </div>

      {/* ----------------------------------------------------- mobile tabs */}
      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/95 backdrop-blur lg:hidden">
        <div className="flex">
          {[...ALL_TABS, { id: "ask" as Tab, label: "Ask", Icon: IconAsk }].map(
            ({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px] font-medium transition ${
                  tab === id ? "text-accent" : "text-faint"
                }`}
              >
                <Icon className="size-[19px]" />
                {/* The desktop rail can afford "Goals & capacity"; a phone tab cannot. */}
                {label === "Goals & capacity" ? "Plan" : label}
              </button>
            ),
          )}
        </div>
      </nav>
    </div>
  );
}

function Mark() {
  return (
    <svg viewBox="0 0 24 24" className="size-[22px] text-ink" aria-hidden="true">
      <path
        d="M12 2c0 5.523 4.477 10 10 10-5.523 0-10 4.477-10 10 0-5.523-4.477-10-10-10 5.523 0 10-4.477 10-10z"
        fill="currentColor"
      />
    </svg>
  );
}
