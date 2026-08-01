import { useEffect, useRef, useState } from "react";

/**
 * True when the user has asked the OS to reduce motion. Live-updates if they
 * change the setting while the app is open.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    // Safari < 14 only supports the deprecated listener API.
    if (query.addEventListener) {
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    }
    query.addListener(onChange);
    return () => query.removeListener(onChange);
  }, []);

  return reduced;
}

/**
 * Counts up to `value` on mount / when the value changes.
 *
 * Honesty note: this only animates how an already-final number is revealed —
 * it never rounds, estimates, or alters the value it is given. Under
 * prefers-reduced-motion it renders the final value immediately.
 */
export function AnimatedCounter({
  value,
  format,
  durationMs = 700,
}: {
  value: number;
  /** Formatter for the in-flight value (e.g. currency, percent). */
  format: (current: number) => string;
  durationMs?: number;
}) {
  const reducedMotion = usePrefersReducedMotion();
  // Seed with the REAL value, never 0. requestAnimationFrame does not fire in
  // background/non-compositing tabs, so a 0 seed could leave a merchant looking
  // at "$0" when the true figure is thousands. The count-up start point is set
  // inside the first animation frame instead — if frames never arrive, the
  // correct number simply stays on screen.
  const [display, setDisplay] = useState(value);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (reducedMotion || durationMs <= 0) {
      setDisplay(value);
      return;
    }

    let startedAt: number | null = null;

    const step = (now: number) => {
      if (startedAt === null) startedAt = now;
      const progress = Math.min(1, (now - startedAt) / durationMs);
      // easeOutCubic — fast start, gentle settle.
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(value * eased);
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        // Land exactly on the real value, never an eased approximation.
        setDisplay(value);
      }
    };

    frameRef.current = requestAnimationFrame(step);

    // Safety net: if the animation is throttled or abandoned part-way (tab
    // backgrounded mid-count), snap to the true value rather than stranding
    // the display on an intermediate number.
    const guard = window.setTimeout(() => setDisplay(value), durationMs + 400);

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      window.clearTimeout(guard);
    };
  }, [value, durationMs, reducedMotion]);

  // The accessible name is always the final value, so screen readers announce
  // the real figure rather than intermediate animation frames.
  return (
    <span aria-label={format(value)}>
      <span aria-hidden={!reducedMotion}>{format(display)}</span>
    </span>
  );
}
