import { useEffect, useState } from "react";

/** Tailwind's `sm` boundary, so JS and CSS agree on what "narrow" means. */
const NARROW = "(max-width: 639px)";

/**
 * True on phone-width screens.
 *
 * Used to turn OFF drag affordances rather than to change layout -- layout is
 * CSS's job. A drag handle or a resize corner inside a 44px touch target is not
 * usable, and offering one that mostly misses is worse than not offering it:
 * the gesture that does land is a scroll, so the user ends up rearranging their
 * dashboard by accident while trying to read it.
 */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(NARROW).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    onChange();
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}
