import type { ReactNode } from "react";
import { IconAsk, IconPlan, IconToday, IconTree, IconWeek, IconWork } from "./Icons";

export type Tab = "today" | "work" | "tree" | "plan" | "review" | "ask" | "intake";

/** Grouped the way Origin groups: what you do daily, then what you set up. */
const GROUPS: { label: string; items: { id: Tab; label: string; Icon: typeof IconToday }[] }[] = [
  {
    label: "Track",
    items: [
      { id: "today", label: "Today", Icon: IconToday },
      { id: "work", label: "Work", Icon: IconWork },
      { id: "tree", label: "Tree", Icon: IconTree },
      { id: "review", label: "Week", Icon: IconWeek },
    ],
  },
  {
    label: "Plan",
    items: [{ id: "plan", label: "Goals & Capacity", Icon: IconPlan }],
  },
];

const ALL_TABS = GROUPS.flatMap((g) => g.items);

/** The mobile tab bar's height, which the session bar has to clear. */
export const MOBILE_NAV_H = 60;

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
  sessionOpen = false,
  bleed = false,
  onAccount,
  children,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  /** Reserves room at the bottom for the session bar, which docks above the
      mobile nav rather than over it. */
  sessionOpen?: boolean;
  /** Hand the view the whole canvas: no padding, no max-width, exact height.
      A map wants the room; a column of cards does not. */
  bleed?: boolean;
  onAccount?: () => void;
  children: ReactNode;
}) {
  const active = ALL_TABS.find((t) => t.id === tab);
  const title = tab === "intake" ? "Set Up" : tab === "ask" ? "Ask" : (active?.label ?? "Optimus");

  return (
    <div
      className={
        bleed
          ? /* flex-col on phones too: the rail is fixed and out of flow, so
               without a flex context here the content column never stretches to
               the viewport height and a full-height child collapses. */
            "flex h-dvh flex-col overflow-hidden lg:flex-row"
          : "min-h-dvh lg:flex"
      }
    >
      {/* ---------------------------------------------------- desktop rail */}
      <aside className="fixed inset-y-0 left-0 hidden w-[248px] flex-col border-r border-line bg-bg px-3 py-5 lg:flex">
        <div className="flex items-center gap-2.5 px-3 pb-7">
          <Mark />
          <span className="display text-subheading">Optimus</span>
        </div>

        <nav className="flex-1 space-y-7" aria-label="Main">
          {GROUPS.map((group) => (
            <div key={group.label}>
              <div className="section-label px-3 pb-2.5">{group.label}</div>
              <div className="space-y-0.5">
                {group.items.map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    onClick={() => setTab(id)}
                    aria-current={tab === id ? "page" : undefined}
                    className={`flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-body-sm transition duration-200 ease-out ${
                      tab === id
                        ? "bg-raised text-ink"
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
          aria-current={tab === "ask" ? "page" : undefined}
          className={`flex items-center gap-2.5 rounded-control border px-3 py-3 text-body-sm transition duration-200 ease-out ${
            tab === "ask"
              ? "border-line bg-raised text-ink"
              : "border-line/60 bg-transparent text-muted hover:text-ink"
          }`}
        >
          <IconAsk className="size-4 shrink-0" />
          Ask Anything
        </button>
      </aside>

      {/* --------------------------------------------------------- content */}
      <div className="flex min-w-0 flex-1 flex-col lg:ml-[248px]">
        <header className="safe-top sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur">
          <div className="flex items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-10">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="lg:hidden">
                <Mark />
              </span>
              <div className="min-w-0">
                <h1 className="display truncate text-subheading lg:text-heading">{title}</h1>
                <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
                  {new Date().toLocaleDateString(undefined, {
                    weekday: "long",
                    month: "short",
                    day: "numeric",
                  })}
                </div>
              </div>
            </div>
            {onAccount && (
              <button
                onClick={onAccount}
                className="rounded-control px-2 py-1 text-[11px] font-medium text-faint transition hover:bg-surface hover:text-ink"
              >
                Account
              </button>
            )}
          </div>
        </header>

        <main
          className={
            bleed
              ? "w-full min-h-0 flex-1"
              : "w-full max-w-[1100px] flex-1 px-4 py-6 sm:px-6 lg:px-10"
          }
          /* Clears the mobile nav, plus the session bar when one is docked above
             it. The bar grows tall in its confirm state, hence the generous
             reserve rather than a fixed padding class. Full-bleed views get the
             same reserve so the map never hides behind the tab bar. */
          style={{
            paddingBottom: `calc(${sessionOpen ? 210 : MOBILE_NAV_H}px + env(safe-area-inset-bottom))`,
          }}
        >
          {children}
        </main>
      </div>

      {/* ----------------------------------------------------- mobile tabs */}
      <nav
        className="safe-bottom fixed inset-x-0 bottom-0 z-50 border-t border-line bg-bg/95 backdrop-blur lg:hidden"
        aria-label="Main"
      >
        <div className="flex">
          {[...ALL_TABS, { id: "ask" as Tab, label: "Ask", Icon: IconAsk }].map(
            ({ id, label, Icon }) => {
              /* The desktop rail can afford "Goals & capacity"; a phone tab cannot. */
              const short = label === "Goals & Capacity" ? "Plan" : label;
              return (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  aria-current={tab === id ? "page" : undefined}
                  aria-label={label}
                  className={`relative flex flex-1 flex-col items-center gap-1 py-3 text-[10px] font-medium transition duration-200 ease-out ${
                    tab === id ? "text-ink" : "text-faint"
                  }`}
                >
                  {/* design.md forbids chromatic colour below 18px -- it vibrates
                      on dark. The active tab is marked by a white rule and full
                      text contrast instead of an accent tint. */}
                  {tab === id && (
                    <span
                      aria-hidden="true"
                      className="absolute inset-x-4 top-0 h-0.5 rounded-full bg-pure"
                    />
                  )}
                  <Icon className="size-[19px]" />
                  {short}
                </button>
              );
            },
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
