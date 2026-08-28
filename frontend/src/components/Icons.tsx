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
