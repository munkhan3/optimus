/** Inline line icons, matched to the sidebar's weight. No icon dependency. */

type P = { className?: string };
const base = "size-[18px] shrink-0";

function Svg({ children, className }: P & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? base}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconToday = (p: P) => (
  <Svg {...p}>
    <path d="M3 10.5 12 4l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />
  </Svg>
);

export const IconWork = (p: P) => (
  <Svg {...p}>
    <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" />
  </Svg>
);

export const IconPlan = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7v5l3.5 2" />
  </Svg>
);

export const IconWeek = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </Svg>
);

export const IconAsk = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.5 13.6 8l4.4 1.6L13.6 11 12 15.5 10.4 11 6 9.6 10.4 8z" />
    <path d="M18.5 15.5 19.2 17.4 21 18l-1.8.7-.7 1.8-.7-1.8L16 18l1.8-.6z" />
  </Svg>
);

export const IconTimer = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="13" r="8" />
    <path d="M12 9v4l2.5 1.5M9 2h6" />
  </Svg>
);

export const IconTree = (p: P) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="2" />
    <circle cx="18" cy="6" r="2" />
    <circle cx="18" cy="18" r="2" />
    <path d="M7 12h4a2 2 0 0 0 2-2V8a2 2 0 0 1 2-2h1M7 12h4a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2h1" />
  </Svg>
);

/**
 * The wordless mark. Filled rather than stroked, so it does not go through
 * Svg -- and it lives here rather than in Shell because the first-run screen
 * shows it without a shell to belong to.
 */
export const Mark = ({ className = "size-[22px] text-ink" }: P) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path
      d="M12 2c0 5.523 4.477 10 10 10-5.523 0-10 4.477-10 10 0-5.523-4.477-10-10-10 5.523 0 10-4.477 10-10z"
      fill="currentColor"
    />
  </svg>
);

export const IconDash = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7.5" height="9" rx="1.5" />
    <rect x="13.5" y="3" width="7.5" height="5.5" rx="1.5" />
    <rect x="3" y="15" width="7.5" height="6" rx="1.5" />
    <rect x="13.5" y="11.5" width="7.5" height="9.5" rx="1.5" />
  </Svg>
);

export const IconRoadmap = (p: P) => (
  <Svg {...p}>
    <path d="M3 6.5h8M3 12h13M3 17.5h6" />
    <circle cx="14.5" cy="6.5" r="1.6" />
    <circle cx="19" cy="12" r="1.6" />
    <circle cx="9.5" cy="17.5" r="1.6" />
  </Svg>
);

/** The drag affordance. Six dots is the universal "pick this up". */
export const IconGrip = ({ className = "size-[14px] shrink-0" }: P) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <circle cx="9" cy="5" r="1.7" />
    <circle cx="15" cy="5" r="1.7" />
    <circle cx="9" cy="12" r="1.7" />
    <circle cx="15" cy="12" r="1.7" />
    <circle cx="9" cy="19" r="1.7" />
    <circle cx="15" cy="19" r="1.7" />
  </svg>
);

export const IconClose = ({ className = "size-[14px] shrink-0" }: P) => (
  <Svg className={className}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const IconPlus = ({ className = "size-[15px] shrink-0" }: P) => (
  <Svg className={className}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
